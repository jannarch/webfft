"""
core/signal_processor.py
FFT-based signal processing: power spectrum, RSSI, peak detection,
noise floor estimation, and threshold-based signal detection.
"""

from __future__ import annotations
import numpy as np
from scipy.signal import windows
from dataclasses import dataclass, field
from typing import List, Optional, Tuple
from utils.logger import get_logger

logger = get_logger("signal_processor")


# ── Data structures ────────────────────────────────────────────────────────────

@dataclass
class SpectrumResult:
    """Output of a single FFT computation."""
    frequencies_hz: np.ndarray      # centre-frequency of each FFT bin
    power_dbm: np.ndarray           # power in dBm per bin
    center_freq_hz: float
    sample_rate_hz: float
    noise_floor_dbm: float          # estimated noise floor
    timestamp: float                # time.time()


@dataclass
class SignalPeak:
    """A detected spectral peak (potential transmitter)."""
    frequency_hz: float
    power_dbm: float
    bandwidth_hz: float
    snr_db: float
    bin_index: int


# ── Signal Processor ──────────────────────────────────────────────────────────

class SignalProcessor:
    """
    Processes raw IQ samples into power spectra and detects peaks.

    Parameters
    ----------
    fft_size       : Number of FFT points (power of 2 recommended).
    window         : Window function name – 'hann' | 'hamming' | 'blackman' | 'flattop'.
    avg_count      : Number of spectra to average (reduces noise).
    """

    WINDOW_FUNCS = {
        "hann": windows.hann,
        "hamming": windows.hamming,
        "blackman": windows.blackman,
        "flattop": windows.flattop,
        "boxcar": windows.boxcar,
    }

    def __init__(
        self,
        fft_size: int = 2048,
        window: str = "hann",
        avg_count: int = 3,
    ):
        self.fft_size = fft_size
        self.avg_count = avg_count
        self._set_window(window)

        # Running average buffer
        self._avg_buffer: List[np.ndarray] = []

        # Noise floor tracking (exponential moving average)
        self._noise_ema: Optional[np.ndarray] = None
        self._ema_alpha = 0.05   # slow adaptation

        # Detection threshold
        self.threshold_db: float = -60.0

        # Max-hold buffer
        self._max_hold: Optional[np.ndarray] = None

        logger.debug("SignalProcessor  fft=%d  window=%s  avg=%d",
                     fft_size, window, avg_count)

    # ── Public API ─────────────────────────────────────────────────────────────

    def process(
        self,
        samples: np.ndarray,
        center_freq_hz: float,
        sample_rate_hz: float,
        timestamp: float,
    ) -> SpectrumResult:
        """
        Compute the power spectrum from raw IQ samples.

        Returns a SpectrumResult with calibrated dBm values.
        """
        # Ensure complex64
        if samples.dtype != np.complex64:
            samples = samples.astype(np.complex64)

        # Trim / zero-pad to fft_size
        n = self.fft_size
        if len(samples) >= n:
            samples = samples[:n]
        else:
            samples = np.pad(samples, (0, n - len(samples)))

        # Apply window
        windowed = samples * self._window

        # FFT → shift so DC is at centre → normalise
        spectrum = np.fft.fftshift(np.fft.fft(windowed, n=n))
        power_linear = (np.abs(spectrum) ** 2) / (n ** 2)
        power_linear = np.maximum(power_linear, 1e-20)   # prevent log(0)

        # Convert to dBm  (assume 50-Ω system, 0 dBm = 1 mW)
        power_dbm = 10.0 * np.log10(power_linear) + 30.0

        # Running average
        self._avg_buffer.append(power_dbm)
        if len(self._avg_buffer) > self.avg_count:
            self._avg_buffer.pop(0)
        power_dbm = np.mean(self._avg_buffer, axis=0)

        # Update max-hold
        if self._max_hold is None:
            self._max_hold = power_dbm.copy()
        else:
            self._max_hold = np.maximum(self._max_hold, power_dbm)

        # Noise floor estimation (lower 20th percentile → EMA)
        noise_estimate = float(np.percentile(power_dbm, 20))
        if self._noise_ema is None:
            self._noise_ema = noise_estimate
        else:
            self._noise_ema = (self._ema_alpha * noise_estimate
                               + (1 - self._ema_alpha) * self._noise_ema)

        # Frequency axis
        freqs = (np.fft.fftshift(np.fft.fftfreq(n, d=1.0 / sample_rate_hz))
                 + center_freq_hz)

        return SpectrumResult(
            frequencies_hz=freqs,
            power_dbm=power_dbm,
            center_freq_hz=center_freq_hz,
            sample_rate_hz=sample_rate_hz,
            noise_floor_dbm=self._noise_ema,
            timestamp=timestamp,
        )

    def detect_peaks(
        self,
        result: SpectrumResult,
        threshold_dbm: float,
        min_separation_hz: float = 50_000,
    ) -> List[SignalPeak]:
        """
        Return detected signal peaks above *threshold_dbm*.

        Parameters
        ----------
        result           : SpectrumResult from process().
        threshold_dbm    : Minimum power level to report a peak.
        min_separation_hz: Minimum distance between adjacent peaks (prevents
                           reporting many bins of the same signal).
        """
        power = result.power_dbm
        freqs = result.frequencies_hz
        bin_width_hz = result.sample_rate_hz / self.fft_size

        above = power > threshold_dbm
        if not np.any(above):
            return []

        # Identify contiguous groups above threshold
        peaks: List[SignalPeak] = []
        in_peak = False
        peak_start = 0

        for i in range(len(power)):
            if above[i] and not in_peak:
                in_peak = True
                peak_start = i
            elif (not above[i] or i == len(power) - 1) and in_peak:
                in_peak = False
                peak_end = i
                segment = power[peak_start:peak_end]
                if len(segment) == 0:
                    continue
                peak_bin = peak_start + int(np.argmax(segment))
                peak_power = float(power[peak_bin])
                peak_freq = float(freqs[peak_bin])
                bandwidth = (peak_end - peak_start) * bin_width_hz
                snr = peak_power - result.noise_floor_dbm

                # Enforce minimum separation
                if peaks and abs(peak_freq - peaks[-1].frequency_hz) < min_separation_hz:
                    # Keep the stronger one
                    if peak_power > peaks[-1].power_dbm:
                        peaks[-1] = SignalPeak(peak_freq, peak_power, bandwidth, snr, peak_bin)
                else:
                    peaks.append(SignalPeak(peak_freq, peak_power, bandwidth, snr, peak_bin))

        return peaks

    def compute_rssi(self, result: SpectrumResult, freq_hz: float, bandwidth_hz: float = 200_000) -> float:
        """
        Compute integrated RSSI in a narrow band around freq_hz.
        Returns power in dBm.
        """
        freq_low = freq_hz - bandwidth_hz / 2
        freq_high = freq_hz + bandwidth_hz / 2
        mask = (result.frequencies_hz >= freq_low) & (result.frequencies_hz <= freq_high)
        if not np.any(mask):
            return result.noise_floor_dbm
        band_power = result.power_dbm[mask]
        # Integrate (add linear power across band, then convert back to dBm)
        lin = 10.0 ** (band_power / 10.0)
        total_dbm = 10.0 * np.log10(np.sum(lin))
        return float(total_dbm)

    def reset_max_hold(self):
        self._max_hold = None

    def reset_average(self):
        self._avg_buffer.clear()
        self._noise_ema = None

    @property
    def max_hold(self) -> Optional[np.ndarray]:
        return self._max_hold

    @property
    def noise_floor_dbm(self) -> float:
        return self._noise_ema if self._noise_ema is not None else -90.0

    # ── Internal ───────────────────────────────────────────────────────────────
    def _set_window(self, name: str):
        fn = self.WINDOW_FUNCS.get(name.lower(), windows.hann)
        self._window = fn(self.fft_size).astype(np.float32)
        self._window_name = name
