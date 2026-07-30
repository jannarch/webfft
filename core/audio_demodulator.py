import numpy as np
from typing import Optional

class AudioDemodulator:
    """
    A pure numpy-based real-time FM demodulator.
    Takes IQ samples at a high sample rate, shifts to baseband,
    decimates, performs FM demodulation (phase differentiation),
    and resamples to 48kHz 16-bit PCM for Web Audio API.
    """
    def __init__(self, target_audio_rate: int = 48000, baseband_rate: float = 240000):
        self.target_audio_rate = target_audio_rate
        self.baseband_rate = baseband_rate
        
        # State across chunks
        self._last_phase = 0.0

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
        # We use a simple block average to act as a low-pass filter and decimate simultaneously
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
            demod = np.abs(baseband)
            # Remove DC offset (the carrier)
            demod = demod - np.mean(demod)
            # Scale
            gain = 2.0
            demod = demod * gain
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
                
            demod = phase_diff
            
            # WBFM deviation is typically around 75kHz, so phase diff is bounded.
            # Normalizing with a fixed gain factor
            gain = 1.0 / (np.pi / 2.0)
            demod = demod * gain

        # 4. Resample to target audio rate (e.g. 48kHz)
        # We use linear interpolation for speed and simplicity in pure numpy
        n_audio_samples = int(len(demod) * self.target_audio_rate / actual_bb_rate)
        
        if n_audio_samples == 0:
            return b""
            
        x_old = np.linspace(0, 1, len(demod))
        x_new = np.linspace(0, 1, n_audio_samples)
        audio = np.interp(x_new, x_old, demod)
        
        # 5. Normalize and convert to 16-bit PCM
        audio = np.clip(audio, -1.0, 1.0)
        
        audio_int16 = np.int16(audio * 32767)
        return audio_int16.tobytes()
