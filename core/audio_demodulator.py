import numpy as np
from typing import Optional

class AudioDemodulator:
    """
    A pure numpy-based real-time AM/FM demodulator.
    Takes IQ samples at a high sample rate, shifts to baseband,
    decimates, performs demodulation, applies low-pass filtering,
    and resamples to 48kHz 16-bit PCM for Web Audio API.
    """
    def __init__(self, target_audio_rate: int = 48000, baseband_rate: float = 240000):
        self.target_audio_rate = target_audio_rate
        self.baseband_rate = baseband_rate
        
        # State across chunks
        self._last_phase = 0.0
        self._dc_block_prev_x = 0.0   # DC blocker state (input)
        self._dc_block_prev_y = 0.0   # DC blocker state (output)

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

    def demodulate(self, samples: np.ndarray, sample_rate_hz: float, target_freq_hz: float, center_freq_hz: float, mode: str = "FM") -> bytes:
        """
        Processes a chunk of complex IQ samples and returns raw 16-bit PCM audio bytes.
        Mode can be "FM" or "AM".
        """
        if len(samples) == 0:
            return b""
            
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
            
            # Low-pass filter: limit AM audio to ~5kHz
            lpf = self._design_lpf(cutoff_hz=5000, sample_rate_hz=actual_bb_rate, num_taps=63)
            demod = np.convolve(demod, lpf, mode='same')
            
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
            
            # Low-pass filter: limit FM audio to ~15kHz
            lpf = self._design_lpf(cutoff_hz=15000, sample_rate_hz=actual_bb_rate, num_taps=63)
            demod = np.convolve(demod, lpf, mode='same')

        # 4. Resample to target audio rate (e.g. 48kHz)
        n_audio_samples = int(len(demod) * self.target_audio_rate / actual_bb_rate)
        
        if n_audio_samples == 0:
            return b""
            
        x_old = np.linspace(0, 1, len(demod))
        x_new = np.linspace(0, 1, n_audio_samples)
        audio = np.interp(x_new, x_old, demod)
        
        # 5. Clip and convert to 16-bit PCM
        audio = np.clip(audio, -1.0, 1.0)
        
        audio_int16 = np.int16(audio * 32767)
        return audio_int16.tobytes()
