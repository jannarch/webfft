import numpy as np
import scipy.signal as sp_signal
from typing import List
from utils.logger import get_logger

logger = get_logger("audio_demodulator")


class AudioDemodulator:
    """
    Real-time AM/FM demodulator.

    Pipeline per call:
      IQ samples (SDR rate, e.g. 20 MHz)
        -> frequency shift to baseband
        -> decimate to BASEBAND_RATE (200 kHz)   <- must be wide enough for FM signal
        -> FM/AM demodulate
        -> low-pass filter
        -> FM de-emphasis (FM only)
        -> linear resample to TARGET_AUDIO_RATE (48 kHz)
        -> emit consistent-sized PCM chunks

    IMPORTANT: BASEBAND_RATE must stay around 200 kHz for FM.
    FM broadcast needs ~200 kHz bandwidth (Carson: 2*(75+15) kHz).
    Setting baseband_rate == target_audio_rate (48 kHz) causes 416x over-decimation
    which destroys the FM signal completely.
    """

    # Fixed intermediate baseband rate - do NOT change to 48000!
    BASEBAND_RATE: float = 200_000.0

    def __init__(
        self,
        target_audio_rate: int = 48_000,
        chunk_duration_sec: float = 0.05,   # 50 ms chunks for reliable delivery
    ):
        self.target_audio_rate = target_audio_rate
        self.baseband_rate = self.BASEBAND_RATE
        self._chunk_duration_sec = chunk_duration_sec

        # Filter states (stateful across callbacks)
        self._last_phase: float = 0.0
        self._dc_block_prev_x: float = 0.0
        self._dc_block_prev_y: float = 0.0
        self._lpf_zi = None
        self._lpf_coeffs_key = None
        self._lpf_b = None
        self._lpf_a = None
        self._deemph_prev_y: float = 0.0

        # Output accumulation buffer
        self._audio_buffer = np.empty(0, dtype=np.float32)

        logger.debug(
            f"AudioDemodulator init: target={target_audio_rate} Hz, "
            f"baseband={self.BASEBAND_RATE:.0f} Hz, "
            f"chunk={chunk_duration_sec*1000:.0f} ms"
        )

    def _get_lpf(self, cutoff_hz: float, rate_hz: float):
        """Return cached FIR LPF coefficients (b, a=1) for scipy.signal.lfilter."""
        key = (round(cutoff_hz), round(rate_hz))
        if key != self._lpf_coeffs_key:
            num_taps = 63
            fc = min(max(cutoff_hz / rate_hz, 1e-4), 0.499)
            n = np.arange(num_taps)
            mid = (num_taps - 1) / 2.0
            with np.errstate(divide="ignore", invalid="ignore"):
                h = np.sin(2 * np.pi * fc * (n - mid)) / (np.pi * (n - mid))
            h[int(mid)] = 2 * fc
            window = 0.54 - 0.46 * np.cos(2 * np.pi * n / (num_taps - 1))
            h = (h * window)
            h = (h / h.sum()).astype(np.float64)
            self._lpf_b = h
            self._lpf_a = np.array([1.0])
            self._lpf_coeffs_key = key
            self._lpf_zi = None   # reset filter state when coeffs change
        return self._lpf_b, self._lpf_a

    def _apply_dc_block(self, sig: np.ndarray, alpha: float = 0.995) -> np.ndarray:
        """Single-pole DC-blocker: y[n] = x[n] - x[n-1] + alpha*y[n-1]."""
        if not hasattr(self, '_dc_zi'):
            self._dc_zi = np.zeros(1, dtype=np.float64)
            self._dc_alpha = alpha
            
        if self._dc_alpha != alpha:
            self._dc_alpha = alpha
            self._dc_zi = np.zeros(1, dtype=np.float64)

        b = np.array([1.0, -1.0], dtype=np.float64)
        a = np.array([1.0, -alpha], dtype=np.float64)
        out, self._dc_zi = sp_signal.lfilter(b, a, sig, zi=self._dc_zi)
        return out.astype(np.float32)

    def _apply_deemphasis(self, sig: np.ndarray, rate_hz: float) -> np.ndarray:
        """75 us first-order IIR de-emphasis: y[n] = alpha*y[n-1] + (1-alpha)*x[n]."""
        tau = 75e-6
        alpha = tau / (tau + 1.0 / rate_hz)
        
        if not hasattr(self, '_deemph_zi'):
            self._deemph_zi = np.zeros(1, dtype=np.float64)
            self._deemph_alpha = alpha
            
        if self._deemph_alpha != alpha:
            self._deemph_alpha = alpha
            self._deemph_zi = np.zeros(1, dtype=np.float64)

        b = np.array([1.0 - alpha], dtype=np.float64)
        a = np.array([1.0, -alpha], dtype=np.float64)
        out, self._deemph_zi = sp_signal.lfilter(b, a, sig, zi=self._deemph_zi)
        return out.astype(np.float32)

    def reset_filter_state(self):
        """Reset all DSP states (call when tuning to a new frequency or mode)."""
        self._last_phase = 0.0
        self._dc_block_prev_x = 0.0
        self._dc_block_prev_y = 0.0
        self._lpf_zi = None
        self._lpf_coeffs_key = None
        self._lpf_b = None
        self._lpf_a = None
        self._deemph_prev_y = 0.0
        self._audio_buffer = np.empty(0, dtype=np.float32)
        logger.debug("AudioDemodulator: filter states reset")

    def flush(self) -> bytes:
        """Return remaining buffered audio and clear the buffer."""
        if len(self._audio_buffer) == 0:
            return b""
        pcm = np.int16(np.clip(self._audio_buffer, -1.0, 1.0) * 32767)
        self._audio_buffer = np.empty(0, dtype=np.float32)
        logger.debug(f"AudioDemodulator: flushed {len(pcm)} samples")
        return pcm.tobytes()

    def demodulate(
        self,
        samples: np.ndarray,
        sample_rate_hz: float,
        target_freq_hz: float,
        center_freq_hz: float,
        mode: str = "FM",
    ) -> List[bytes]:
        if len(samples) == 0 or sample_rate_hz <= 0:
            return []

        # 1. Frequency-shift station to baseband
        offset = center_freq_hz - target_freq_hz
        t = np.arange(len(samples), dtype=np.float32) / sample_rate_hz
        shifted = (samples * np.exp(2j * np.pi * offset * t)).astype(np.complex64)

        # 2. Decimate to BASEBAND_RATE (~200 kHz)
        decimation_factor = max(1, int(sample_rate_hz / self.BASEBAND_RATE))
        actual_bb_rate = sample_rate_hz / decimation_factor

        if decimation_factor > 1:
            trim = len(shifted) - (len(shifted) % decimation_factor)
            if trim == 0:
                return []
            baseband = shifted[:trim].reshape(-1, decimation_factor).mean(axis=1)
        else:
            baseband = shifted

        if len(baseband) == 0:
            return []

        # 3. Demodulate
        if mode.upper() == "AM":
            demod = np.abs(baseband).astype(np.float32)
            demod = self._apply_dc_block(demod, alpha=0.995)

            b, a = self._get_lpf(cutoff_hz=5_000, rate_hz=actual_bb_rate)
            if self._lpf_zi is None:
                self._lpf_zi = np.zeros(len(b) - 1, dtype=np.float64)
            demod, self._lpf_zi = sp_signal.lfilter(b, a, demod, zi=self._lpf_zi)
            demod = demod.astype(np.float32)
            
            # Fixed gain for AM (avoid per-chunk peak normalization which ruins audio)
            demod *= 2.0 

        else:  # FM
            # Delay-multiply FM demodulation (avoids unwrap issues)
            # phase_diff = angle( x[n] * conj(x[n-1]) )
            if not hasattr(self, '_last_complex_sample'):
                self._last_complex_sample = np.complex64(0.0)
            
            delayed = np.concatenate(([self._last_complex_sample], baseband[:-1]))
            self._last_complex_sample = baseband[-1]
            
            phase_diff = np.angle(baseband * np.conj(delayed)).astype(np.float32)

            # Normalize: +/-75 kHz deviation -> +/-1.0
            max_dev = 75_000.0
            demod = phase_diff * (actual_bb_rate / (2.0 * np.pi * max_dev))

            demod = self._apply_dc_block(demod, alpha=0.995)

            b, a = self._get_lpf(cutoff_hz=15_000, rate_hz=actual_bb_rate)
            if self._lpf_zi is None:
                self._lpf_zi = np.zeros(len(b) - 1, dtype=np.float64)
            demod, self._lpf_zi = sp_signal.lfilter(b, a, demod, zi=self._lpf_zi)
            demod = demod.astype(np.float32)

            demod = self._apply_deemphasis(demod, actual_bb_rate)
            
            # Fixed gain for FM
            demod *= 2.0

        # 4. Resample to 48 kHz (Fast Linear Interpolation)
        if len(demod) < 2:
            return []

        n_out = int(round(len(demod) * self.target_audio_rate / actual_bb_rate))
        if n_out < 1:
            return []

        audio = np.interp(
            np.linspace(0.0, 1.0, n_out),
            np.linspace(0.0, 1.0, len(demod)),
            demod,
        ).astype(np.float32)

        # 5. Accumulate and emit fixed-size chunks
        self._audio_buffer = np.concatenate([self._audio_buffer, audio])

        chunk_samples = int(self.target_audio_rate * self._chunk_duration_sec)
        chunks = []

        while len(self._audio_buffer) >= chunk_samples:
            chunk = self._audio_buffer[:chunk_samples]
            self._audio_buffer = self._audio_buffer[chunk_samples:]
            pcm = np.int16(np.clip(chunk, -1.0, 1.0) * 32767)
            chunks.append(pcm.tobytes())

        return chunks

