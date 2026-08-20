import numpy as np
import scipy.signal as sp_signal
from typing import Optional, List

class AudioDemodulator:
    """
    A pure numpy-based real-time AM/FM demodulator.
    Takes IQ samples at a high sample rate, shifts to baseband,
    decimates, performs demodulation, applies low-pass filtering,
    and resamples to 48kHz 16-bit PCM for Web Audio API.
    """
    def __init__(self, target_audio_rate: int = 48000, baseband_rate: float = 48000, chunk_duration_sec: float = 0.2):
        self.target_audio_rate = target_audio_rate
        self.baseband_rate = baseband_rate
        self._chunk_duration_sec = chunk_duration_sec
        
        # State across chunks
        self._last_phase = 0.0
        self._dc_block_prev_x = 0.0   # DC blocker state (input)
        self._dc_block_prev_y = 0.0   # DC blocker state (output)
        
        # Stateful LPF initial conditions (one per channel, but we have mono)
        self._lpf_zi = None
        self._lpf_coeffs = None  # (b, a) tuple cached between calls
        
        # FM de-emphasis state
        self._deemph_prev_y = 0.0
        
        # Output buffer for consistent chunk sizes
        self._audio_buffer = np.array([], dtype=np.float64)

    @staticmethod
    def _design_lpf(cutoff_hz: float, sample_rate_hz: float, num_taps: int = 63) -> np.ndarray:
        """Design a windowed-sinc low-pass FIR filter using a Hamming window (pure numpy)."""
        fc = cutoff_hz / sample_rate_hz  # Normalized cutoff (0 to 0.5)
        # Ensure odd number of taps for symmetry
        if num_taps % 2 == 0:
            num_taps += 1
        
        n = np.arange(num_taps)
        mid = (num_taps - 1) / 2.0
        
        # Sinc function
        with np.errstate(divide='ignore', invalid='ignore'):
            h = np.sin(2 * np.pi * fc * (n - mid)) / (np.pi * (n - mid))
        h[int(mid)] = 2 * fc  # Handle the center tap (L'Hôpital's rule)
        
        # Hamming window
        window = 0.54 - 0.46 * np.cos(2 * np.pi * n / (num_taps - 1))
        h = h * window
        
        # Normalize for unity gain at DC
        h = h / np.sum(h)
        return h.astype(np.float32)

    @staticmethod
    def _apply_dc_block(signal: np.ndarray, prev_x: float, prev_y: float, alpha: float = 0.995):
        """
        Single-pole DC blocking filter: y[n] = x[n] - x[n-1] + alpha * y[n-1]
        Removes the DC component while preserving the AC (audio) content.
        Returns (filtered_signal, last_x, last_y).
        """
        out = np.empty_like(signal)
        x_prev = prev_x
        y_prev = prev_y
        for i in range(len(signal)):
            out[i] = signal[i] - x_prev + alpha * y_prev
            x_prev = signal[i]
            y_prev = out[i]
        return out, x_prev, y_prev

    def _get_lpf_coeffs(self, cutoff_hz: float, sample_rate_hz: float, num_taps: int = 63):
        """Return cached LPF coefficients (b, a) for lfilter."""
        key = (cutoff_hz, sample_rate_hz, num_taps)
        if self._lpf_coeffs is None or self._lpf_coeffs[0] != key:
            fc = cutoff_hz / sample_rate_hz
            if num_taps % 2 == 0:
                num_taps += 1
            n = np.arange(num_taps)
            mid = (num_taps - 1) / 2.0
            with np.errstate(divide='ignore', invalid='ignore'):
                h = np.sin(2 * np.pi * fc * (n - mid)) / (np.pi * (n - mid))
            h[int(mid)] = 2 * fc
            window = 0.54 - 0.46 * np.cos(2 * np.pi * n / (num_taps - 1))
            h = h * window
            h = h / np.sum(h)
            # Convert FIR to IIR via scipy.signal.tf2ss? No, use lfilter with b=h, a=[1.0]
            # lfilter expects a[0]=1 for FIR
            b = h.astype(np.float64)
            a = np.array([1.0], dtype=np.float64)
            self._lpf_coeffs = (key, b, a)
        return self._lpf_coeffs[1], self._lpf_coeffs[2]

    def _apply_deemphasis(self, signal: np.ndarray, sample_rate_hz: float) -> np.ndarray:
        """75 µs FM de-emphasis IIR filter: y[n] = (1 - alpha) * x[n] + alpha * y[n-1]"""
        tau = 75e-6  # 75 microseconds
        dt = 1.0 / sample_rate_hz
        alpha = tau / (tau + dt)
        # Correct IIR low-pass: feedforward is (1-alpha), feedback is alpha (represented as -alpha in 'a' array)
        b = np.array([1.0 - alpha], dtype=np.float64)
        a = np.array([1.0, -alpha], dtype=np.float64)
        zi = np.array([float(self._deemph_prev_y)], dtype=np.float64)
        signal, zf = sp_signal.lfilter(b, a, signal, zi=zi)
        self._deemph_prev_y = float(zf[0])
        return signal

    def reset_filter_state(self):
        """Reset all filter states (call when changing frequency/mode)."""
        self._last_phase = 0.0
        self._dc_block_prev_x = 0.0
        self._dc_block_prev_y = 0.0
        self._lpf_zi = None
        self._deemph_prev_y = 0.0
        self._audio_buffer = np.array([], dtype=np.float64)

    def flush(self) -> bytes:
        """Return any remaining buffered audio samples and clear the buffer."""
        if len(self._audio_buffer) == 0:
            return b""
        audio = np.clip(self._audio_buffer, -1.0, 1.0)
        audio_int16 = np.int16(audio * 32767)
        self._audio_buffer = np.array([], dtype=np.float64)
        return audio_int16.tobytes()

    def demodulate(self, samples: np.ndarray, sample_rate_hz: float, target_freq_hz: float, center_freq_hz: float, mode: str = "FM") -> List[bytes]:
        """
        Processes a chunk of complex IQ samples and returns a list of 20ms PCM audio chunks.
        Mode can be "FM" or "AM".
        """
        if len(samples) == 0:
            return []
            
        # 1. Frequency shift to baseband
        offset = center_freq_hz - target_freq_hz
        t = np.arange(len(samples), dtype=np.float32) / sample_rate_hz
        shifted = samples * np.exp(2j * np.pi * offset * t).astype(np.complex64)
        
        # 2. Decimate (downsample)
        decimation_factor = int(sample_rate_hz // self.baseband_rate)
        
        if decimation_factor > 1:
            n_pad = decimation_factor - (len(shifted) % decimation_factor)
            if n_pad != decimation_factor:
                shifted = np.pad(shifted, (0, n_pad))
            baseband = shifted.reshape(-1, decimation_factor).mean(axis=1)
        else:
            baseband = shifted
            
        actual_bb_rate = sample_rate_hz / max(1, decimation_factor)
        
        # 3. Demodulation
        if mode.upper() == "AM":
            # AM Demodulation (Envelope detection)
            demod = np.abs(baseband).astype(np.float32)
            
            # DC blocking filter (removes carrier residual cleanly across chunks)
            demod, self._dc_block_prev_x, self._dc_block_prev_y = self._apply_dc_block(
                demod, self._dc_block_prev_x, self._dc_block_prev_y, alpha=0.995
            )
            
            # Stateful low-pass filter: limit AM audio to ~5kHz
            b, a = self._get_lpf_coeffs(cutoff_hz=5000, sample_rate_hz=actual_bb_rate)
            if self._lpf_zi is None:
                self._lpf_zi = np.zeros(max(len(a), len(b)) - 1, dtype=np.float64)
            demod, self._lpf_zi = sp_signal.lfilter(b, a, demod, zi=self._lpf_zi)
            
            # Normalize AM
            peak = np.max(np.abs(demod))
            if peak > 1e-6:
                demod = demod / peak * 0.8
        else:
            # FM Demodulation (Phase differentiation)
            angles = np.angle(baseband)
            
            if len(angles) > 0:
                phase_diff = np.diff(np.concatenate(([self._last_phase], angles)))
                # Unwrap phase difference (wrap to -pi to pi)
                phase_diff = (phase_diff + np.pi) % (2 * np.pi) - np.pi
                self._last_phase = angles[-1]
            else:
                phase_diff = np.array([], dtype=np.float32)
                
            demod = phase_diff.astype(np.float32)
            
            # Normalize FM deviation
            gain = 1.0 / (np.pi / 2.0)
            demod = demod * gain
            
            # Stateful low-pass filter: limit FM audio to ~15kHz
            b, a = self._get_lpf_coeffs(cutoff_hz=15000, sample_rate_hz=actual_bb_rate)
            if self._lpf_zi is None:
                self._lpf_zi = np.zeros(max(len(a), len(b)) - 1, dtype=np.float64)
            demod, self._lpf_zi = sp_signal.lfilter(b, a, demod, zi=self._lpf_zi)
            
            # FM de-emphasis (75 µs time constant)
            demod = self._apply_deemphasis(demod, actual_bb_rate)

        # 4. Resample to target audio rate (e.g. 48kHz)
        n_audio_samples = int(len(demod) * self.target_audio_rate / actual_bb_rate)
        
        if n_audio_samples == 0:
            return []
            
        x_old = np.linspace(0, 1, len(demod))
        x_new = np.linspace(0, 1, n_audio_samples)
        audio = np.interp(x_new, x_old, demod)
        
        # 5. Clip and buffer
        audio = np.clip(audio, -1.0, 1.0)
        self._audio_buffer = np.concatenate([self._audio_buffer, audio.astype(np.float64)])
        
        # 6. Return consistent-sized chunks
        chunk_samples = int(self.target_audio_rate * self._chunk_duration_sec)
        chunks = []
        while len(self._audio_buffer) >= chunk_samples:
            chunk = self._audio_buffer[:chunk_samples]
            self._audio_buffer = self._audio_buffer[chunk_samples:]
            audio_int16 = np.int16(np.clip(chunk, -1.0, 1.0) * 32767)
            chunks.append(audio_int16.tobytes())
        return chunks
