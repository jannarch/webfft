import numpy as np
import scipy.signal as sp_signal
from typing import List
from core.cpp_dsp_wrapper import CppDSP
from utils.logger import get_logger

logger = get_logger("audio_demodulator")


class AudioDemodulator:
    """
    Real-time AM/FM demodulator accelerated by native C++ DSP.

    Pipeline per call:
      IQ samples (SDR rate, e.g. 20 MHz)
        -> C++ frequency shift & decimate to BASEBAND_RATE (200 kHz)
        -> C++ FM/AM demodulate
        -> low-pass filter
        -> C++ FM de-emphasis (FM only)
        -> C++ linear resample to TARGET_AUDIO_RATE (48 kHz)
        -> emit consistent-sized PCM chunks
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

        # Native C++ DSP engine
        self._cpp_dsp = CppDSP()

        # Filter states (stateful across callbacks)
        self._last_nco_phase: float = 0.0
        self._last_i: float = 0.0
        self._last_q: float = 0.0
        self._dc_prev_x: float = 0.0
        self._dc_prev_y: float = 0.0
        self._deemph_prev_y: float = 0.0

        self._lpf_zi = None
        self._lpf_coeffs_key = None
        self._lpf_b = None
        self._lpf_a = None

        # Output accumulation buffer
        self._audio_buffer = np.empty(0, dtype=np.float32)

        accel = "Native C++ DLL (AVX2/FMA)" if self._cpp_dsp.is_native_available else "NumPy Fallback"
        logger.info(
            f"AudioDemodulator init: [{accel}], target={target_audio_rate} Hz, "
            f"baseband={self.BASEBAND_RATE:.0f} Hz, chunk={chunk_duration_sec*1000:.0f} ms"
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
        self._last_nco_phase = 0.0
        self._last_i = 0.0
        self._last_q = 0.0
        self._dc_prev_x = 0.0
        self._dc_prev_y = 0.0
        self._deemph_prev_y = 0.0
        self._lpf_zi = None
        self._lpf_coeffs_key = None
        self._lpf_b = None
        self._lpf_a = None
        self._audio_buffer = np.empty(0, dtype=np.float32)
        logger.debug("AudioDemodulator: filter states reset")

    def flush(self) -> bytes:
        """Return remaining buffered audio and clear the buffer."""
        if len(self._audio_buffer) == 0:
            return b""
        pcm = self._cpp_dsp.float_to_int16(self._audio_buffer, 1.0)
        self._audio_buffer = np.empty(0, dtype=np.float32)
        logger.debug(f"AudioDemodulator: flushed {len(pcm)} samples")
        return pcm.tobytes()

    def get_stats(self) -> dict:
        """Return diagnostic statistics about the audio demodulator."""
        return {
            "native_cpp": self._cpp_dsp.is_native_available,
            "target_rate": self.target_audio_rate,
            "baseband_rate": self.baseband_rate,
            "buffer_samples": len(self._audio_buffer),
        }

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

        # 1. Frequency-shift station to baseband and decimate (C++ NCO)
        offset = center_freq_hz - target_freq_hz
        decimation_factor = max(1, int(sample_rate_hz / self.BASEBAND_RATE))
        actual_bb_rate = sample_rate_hz / decimation_factor

        baseband, self._last_nco_phase = self._cpp_dsp.shift_and_decimate(
            samples=samples,
            sample_rate_hz=sample_rate_hz,
            offset_hz=offset,
            phase=self._last_nco_phase,
            decimation_factor=decimation_factor,
        )

        if len(baseband) == 0:
            return []

        # 2. Demodulate
        if mode.upper() == "AM":
            demod = self._cpp_dsp.demod_am(baseband, scale_factor=1.0)
            demod, self._dc_prev_x, self._dc_prev_y = self._cpp_dsp.dc_block(
                demod, alpha=0.995, prev_x=self._dc_prev_x, prev_y=self._dc_prev_y
            )

            b, a = self._get_lpf(cutoff_hz=5_000, rate_hz=actual_bb_rate)
            if self._lpf_zi is None:
                self._lpf_zi = np.zeros(len(b) - 1, dtype=np.float64)
            demod, self._lpf_zi = sp_signal.lfilter(b, a, demod, zi=self._lpf_zi)
            demod = demod.astype(np.float32)
            
            # Fixed gain for AM
            demod *= 2.0

        else:  # FM
            max_dev = 75_000.0
            scale_factor = actual_bb_rate / (2.0 * np.pi * max_dev)

            demod, self._last_i, self._last_q = self._cpp_dsp.demod_fm(
                baseband=baseband,
                scale_factor=scale_factor,
                last_i=self._last_i,
                last_q=self._last_q,
            )

            demod, self._dc_prev_x, self._dc_prev_y = self._cpp_dsp.dc_block(
                demod, alpha=0.995, prev_x=self._dc_prev_x, prev_y=self._dc_prev_y
            )

            b, a = self._get_lpf(cutoff_hz=15_000, rate_hz=actual_bb_rate)
            if self._lpf_zi is None:
                self._lpf_zi = np.zeros(len(b) - 1, dtype=np.float64)
            demod, self._lpf_zi = sp_signal.lfilter(b, a, demod, zi=self._lpf_zi)
            demod = demod.astype(np.float32)

            # De-emphasis (75 us)
            tau = 75e-6
            alpha = float(tau / (tau + 1.0 / actual_bb_rate))
            demod, self._deemph_prev_y = self._cpp_dsp.deemphasis(
                demod, alpha=alpha, prev_y=self._deemph_prev_y
            )
            
            # Fixed gain for FM
            demod *= 2.0

        # 3. Resample to 48 kHz
        if len(demod) < 2:
            return []

        n_out = int(round(len(demod) * self.target_audio_rate / actual_bb_rate))
        if n_out < 1:
            return []

        audio = self._cpp_dsp.resample_linear(demod, n_out)

        # 4. Accumulate and emit fixed-size chunks
        self._audio_buffer = np.concatenate([self._audio_buffer, audio])

        chunk_samples = int(self.target_audio_rate * self._chunk_duration_sec)
        chunks = []

        while len(self._audio_buffer) >= chunk_samples:
            chunk = self._audio_buffer[:chunk_samples]
            self._audio_buffer = self._audio_buffer[chunk_samples:]
            pcm = self._cpp_dsp.float_to_int16(chunk, 1.0)
            chunks.append(pcm.tobytes())

        return chunks

