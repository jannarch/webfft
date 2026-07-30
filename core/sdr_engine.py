"""
core/sdr_engine.py
SDR hardware abstraction for HackRF One via SoapySDR.
Automatically falls back to a realistic simulation when hardware is absent.
Supports:
  - Single-channel continuous RX
  - Wideband frequency sweep
  - Multi-SDR mode (multiple SoapySDR devices)
"""

from __future__ import annotations

import time
import threading
import math
import random
import numpy as np
from enum import Enum
from dataclasses import dataclass, field
from typing import List, Optional, Callable, Any

from utils.logger import get_logger

logger = get_logger("sdr_engine")


# ── Enumerations & Config ──────────────────────────────────────────────────────

class SDRMode(str, Enum):
    HARDWARE = "hardware"
    SIMULATION = "simulation"


class ScanMode(str, Enum):
    SINGLE = "single"        # Fixed frequency, continuous
    SWEEP = "sweep"          # Step through a frequency range


@dataclass
class SDRConfig:
    center_frequency_hz: float = 100e6
    sample_rate_hz: float = 2e6
    lna_gain: int = 16
    vga_gain: int = 20
    amp_enabled: bool = False
    fft_size: int = 2048
    update_rate_hz: float = 25.0

    # Sweep parameters
    scan_mode: ScanMode = ScanMode.SINGLE
    sweep_start_hz: float = 88e6
    sweep_stop_hz: float = 108e6
    sweep_step_hz: float = 2e6
    dwell_time_ms: float = 200.0


# ── Simulation Engine ─────────────────────────────────────────────────────────

class _SimSignal:
    """One persistent simulated carrier."""
    def __init__(self, freq_offset_hz: float, power_lin: float, bw_hz: float = 100e3, is_fm: bool = False):
        self.freq_offset = freq_offset_hz
        self.power = power_lin
        self.bw = bw_hz
        self.phase = random.uniform(0, 2 * math.pi)
        self.is_fm = is_fm


class SimulationEngine:
    """Generates realistic IQ samples without real hardware."""

    def __init__(self):
        self._noise_power = 10 ** ((-90 - 30) / 10)   # -90 dBm in mW
        self._persistent_signals: List[_SimSignal] = []
        self._burst: Optional[_SimSignal] = None
        self._burst_remaining = 0.0
        self._burst_cooldown = 0.0
        self._time_acc = 0.0
        self._setup_default_signals()

    def _setup_default_signals(self):
        """Pre-populate with a few 'always-on' signals."""
        self._persistent_signals = [
            # The primary signal at 0 offset is a simulated FM broadcast with a 1kHz tone (75kHz deviation)
            _SimSignal(freq_offset_hz=0,       power_lin=10 ** ((-55-30)/10), bw_hz=200e3, is_fm=True),
            _SimSignal(freq_offset_hz=600e3,   power_lin=10 ** ((-65-30)/10), bw_hz=80e3),
            _SimSignal(freq_offset_hz=-400e3,  power_lin=10 ** ((-70-30)/10), bw_hz=120e3),
        ]

    def generate(self, n_samples: int, center_freq_hz: float, sample_rate_hz: float) -> np.ndarray:
        t = np.arange(n_samples, dtype=np.float32) / sample_rate_hz

        # Noise
        noise_std = math.sqrt(self._noise_power / 2)
        samples = (np.random.normal(0, noise_std, n_samples).astype(np.float32)
                   + 1j * np.random.normal(0, noise_std, n_samples).astype(np.float32))

        # Persistent signals
        # Add a time tracker for continuous FM phase across chunks
        self._time_acc += n_samples / sample_rate_hz
        chunk_t_global = np.arange(n_samples, dtype=np.float32) / sample_rate_hz + (self._time_acc - n_samples / sample_rate_hz)
        
        for sig in self._persistent_signals:
            amp = math.sqrt(sig.power)
            if sig.is_fm:
                # 1kHz tone, 75kHz deviation
                fm_mod = 75e3 / 1e3 * np.sin(2 * math.pi * 1000 * chunk_t_global)
                carrier = np.exp(1j * (2 * math.pi * sig.freq_offset * t + sig.phase + fm_mod)).astype(np.complex64)
                samples += (amp * carrier).astype(np.complex64)
            else:
                # slight AM modulation for realism
                am = 1.0 + 0.15 * np.sin(2 * math.pi * 400 * t)
                carrier = np.exp(1j * (2 * math.pi * sig.freq_offset * t + sig.phase)).astype(np.complex64)
                samples += (amp * am * carrier).astype(np.complex64)
                
            sig.phase += 2 * math.pi * sig.freq_offset * (n_samples / sample_rate_hz)
            sig.phase %= (2 * math.pi)

        # Burst signals
        self._burst_cooldown -= n_samples / sample_rate_hz
        self._burst_remaining -= n_samples / sample_rate_hz

        if self._burst is not None and self._burst_remaining > 0:
            amp = math.sqrt(self._burst.power)
            carrier = np.exp(1j * 2 * math.pi * self._burst.freq_offset * t).astype(np.complex64)
            samples += (amp * carrier).astype(np.complex64)
        else:
            self._burst = None
            if self._burst_cooldown <= 0 and random.random() < 0.15:
                bw = random.uniform(50e3, 400e3)
                pwr = 10 ** ((random.uniform(-75, -50) - 30) / 10)
                offset = random.uniform(-sample_rate_hz * 0.4, sample_rate_hz * 0.4)
                self._burst = _SimSignal(offset, pwr, bw)
                self._burst_remaining = random.uniform(0.1, 1.5)
                self._burst_cooldown = random.uniform(1.0, 5.0)

        return samples.astype(np.complex64)

    def add_signal(self, freq_offset_hz: float, power_dbm: float):
        pwr = 10 ** ((power_dbm - 30) / 10)
        self._persistent_signals.append(_SimSignal(freq_offset_hz, pwr))

    def remove_signals(self):
        self._persistent_signals.clear()
        self._setup_default_signals()


# ── Worker Thread ─────────────────────────────────────────────────────────────

class SDRWorker(threading.Thread):
    """
    Background thread that continuously reads IQ samples from either
    the HackRF hardware (via SoapySDR) or the SimulationEngine.
    """
    
    def __init__(self, config: SDRConfig, sim_engine: SimulationEngine):
        super().__init__()
        self.daemon = True
        self._config = config
        self._sim = sim_engine
        self._mode = SDRMode.SIMULATION
        self._running = False
        self._lock = threading.Lock()

        # Callbacks
        self.on_samples_ready: Optional[Callable[[np.ndarray, float, float, float], None]] = None
        self.on_status_changed: Optional[Callable[[str], None]] = None
        self.on_mode_changed: Optional[Callable[[str], None]] = None
        self.on_error_occurred: Optional[Callable[[str], None]] = None

        # SoapySDR objects
        self._sdr = None
        self._rx_stream = None

        # Sweep state
        self._current_sweep_freq = config.sweep_start_hz

    # ── Public control ─────────────────────────────────────────────────────────

    @property
    def mode(self) -> SDRMode:
        return self._mode

    def try_hardware(self) -> bool:
        """Attempt to connect to HackRF via SoapySDR. Returns True on success."""
        try:
            import SoapySDR  # type: ignore
            from SoapySDR import SOAPY_SDR_RX, SOAPY_SDR_CF32  # type: ignore

            results = SoapySDR.Device.enumerate()
            hackrf_kwargs = None
            for r in results:
                driver_name = None
                try:
                    driver_name = r.get("driver", None)
                except Exception:
                    driver_name = None

                if driver_name is None:
                    driver_name = str(r)

                if isinstance(driver_name, bytes):
                    driver_name = driver_name.decode(errors="ignore")

                driver_lower = str(driver_name).lower()
                if "hackrf" in driver_lower:
                    hackrf_kwargs = r
                    break

            if not hackrf_kwargs:
                logger.info("SoapySDR: no HackRF device found. Enumerated devices: %s", results)
                return False

            self._sdr = SoapySDR.Device(hackrf_kwargs)
            self._apply_hardware_config()
            self._mode = SDRMode.HARDWARE
            logger.info("HackRF One detected and configured.")
            return True
        except ImportError:
            logger.warning("SoapySDR not installed – falling back to simulation.")
        except Exception as e:
            logger.warning("Hardware init failed: %s – using simulation.", e)
        return False

    def set_frequency(self, freq_hz: float):
        with self._lock:
            self._config.center_frequency_hz = freq_hz
            if self._mode == SDRMode.HARDWARE and self._sdr is not None:
                try:
                    # pyrefly: ignore [missing-import]
                    import SoapySDR
                    self._sdr.setFrequency(SoapySDR.SOAPY_SDR_RX, 0, freq_hz)
                except Exception as e:
                    logger.error("setFrequency error: %s", e)

    def set_gain(self, lna: int, vga: int, amp: bool):
        with self._lock:
            self._config.lna_gain = lna
            self._config.vga_gain = vga
            self._config.amp_enabled = amp
            if self._mode == SDRMode.HARDWARE and self._sdr is not None:
                try:
                    # pyrefly: ignore [missing-import]
                    import SoapySDR
                    self._sdr.setGain(SoapySDR.SOAPY_SDR_RX, 0, "LNA", lna)
                    self._sdr.setGain(SoapySDR.SOAPY_SDR_RX, 0, "VGA", vga)
                    self._sdr.setGain(SoapySDR.SOAPY_SDR_RX, 0, "AMP", 14 if amp else 0)
                except Exception as e:
                    logger.error("setGain error: %s", e)

    def set_sample_rate(self, sr_hz: float):
        with self._lock:
            self._config.sample_rate_hz = sr_hz
            if self._mode == SDRMode.HARDWARE and self._sdr is not None:
                try:
                    # pyrefly: ignore [missing-import]
                    import SoapySDR
                    self._sdr.setSampleRate(SoapySDR.SOAPY_SDR_RX, 0, sr_hz)
                except Exception as e:
                    logger.error("setSampleRate error: %s", e)

    def stop(self):
        self._running = False

    # ── Thread run ────────────────────────────────────────────────────────────

    def run(self):
        self._running = True
        if self.on_status_changed:
            self.on_status_changed(f"[{self._mode.value.upper()}] Streaming…")
        if self.on_mode_changed:
            self.on_mode_changed(self._mode.value)

        if self._mode == SDRMode.HARDWARE:
            self._run_hardware()
        else:
            self._run_simulation()

    # ── Hardware loop ──────────────────────────────────────────────────────────

    def _run_hardware(self):
        try:
            # pyrefly: ignore [missing-import]
            import SoapySDR
            # pyrefly: ignore [missing-import]
            from SoapySDR import SOAPY_SDR_RX, SOAPY_SDR_CF32

            self._rx_stream = self._sdr.setupStream(SOAPY_SDR_RX, SOAPY_SDR_CF32)
            self._sdr.activateStream(self._rx_stream)
            n = self._config.fft_size * 4
            buff = np.zeros(n, dtype=np.complex64)
            self._current_sweep_freq = self._config.sweep_start_hz
            dwell_end = time.time() + self._config.dwell_time_ms / 1000.0

            while self._running:
                ret = self._sdr.readStream(self._rx_stream, [buff], n, timeoutUs=500_000)
                if ret.ret < 0:
                    continue

                samples = buff[:ret.ret].copy()
                center = self._config.center_frequency_hz
                sr = self._config.sample_rate_hz

                # Sweep logic
                if self._config.scan_mode == ScanMode.SWEEP:
                    if time.time() >= dwell_end:
                        self._current_sweep_freq += self._config.sweep_step_hz
                        if self._current_sweep_freq > self._config.sweep_stop_hz:
                            self._current_sweep_freq = self._config.sweep_start_hz
                        self.set_frequency(self._current_sweep_freq)
                        center = self._current_sweep_freq
                        dwell_end = time.time() + self._config.dwell_time_ms / 1000.0

                if self.on_samples_ready:
                    self.on_samples_ready(samples, center, sr, time.time())

        except Exception as e:
            logger.error("Hardware streaming error: %s", e)
            if self.on_error_occurred:
                self.on_error_occurred(str(e))
            self._mode = SDRMode.SIMULATION
            if self.on_mode_changed:
                self.on_mode_changed(self._mode.value)
            self._run_simulation()
        finally:
            self._cleanup_hardware()

    # ── Simulation loop ────────────────────────────────────────────────────────

    def _run_simulation(self):
        n = self._config.fft_size * 4
        target_interval = 1.0 / self._config.update_rate_hz
        self._current_sweep_freq = self._config.sweep_start_hz
        dwell_end = time.time() + self._config.dwell_time_ms / 1000.0

        while self._running:
            t0 = time.time()

            with self._lock:
                center = self._config.center_frequency_hz
                sr = self._config.sample_rate_hz
                scan = self._config.scan_mode

            # Sweep
            if scan == ScanMode.SWEEP:
                if t0 >= dwell_end:
                    self._current_sweep_freq += self._config.sweep_step_hz
                    if self._current_sweep_freq > self._config.sweep_stop_hz:
                        self._current_sweep_freq = self._config.sweep_start_hz
                    center = self._current_sweep_freq
                    with self._lock:
                        self._config.center_frequency_hz = center
                    dwell_end = t0 + self._config.dwell_time_ms / 1000.0

            samples = self._sim.generate(n, center, sr)
            if self.on_samples_ready:
                self.on_samples_ready(samples, center, sr, time.time())

            elapsed = time.time() - t0
            sleep_time = target_interval - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

    # ── Helpers ────────────────────────────────────────────────────────────────

    def _apply_hardware_config(self):
        # pyrefly: ignore [missing-import]
        import SoapySDR
        sdr = self._sdr
        sdr.setSampleRate(SoapySDR.SOAPY_SDR_RX, 0, self._config.sample_rate_hz)
        sdr.setFrequency(SoapySDR.SOAPY_SDR_RX, 0, self._config.center_frequency_hz)
        sdr.setGain(SoapySDR.SOAPY_SDR_RX, 0, "LNA", self._config.lna_gain)
        sdr.setGain(SoapySDR.SOAPY_SDR_RX, 0, "VGA", self._config.vga_gain)
        if self._config.amp_enabled:
            sdr.setGain(SoapySDR.SOAPY_SDR_RX, 0, "AMP", 14)

    def _cleanup_hardware(self):
        if self._rx_stream is not None and self._sdr is not None:
            try:
                self._sdr.deactivateStream(self._rx_stream)
                self._sdr.closeStream(self._rx_stream)
            except Exception:
                pass
        self._rx_stream = None


# ── Multi-SDR Manager ─────────────────────────────────────────────────────────

class MultiSDRManager:
    """
    Manages multiple SDRWorker instances for multi-receiver mode (TDOA/trilateration).
    Each worker streams samples independently; the manager provides a unified
    callback interface.
    """

    def __init__(self, configs: List[SDRConfig]):
        self._configs = configs
        self._workers: List[SDRWorker] = []
        self._sim_engines: List[SimulationEngine] = []

    def initialize(self) -> List[SDRMode]:
        modes: List[SDRMode] = []
        for cfg in self._configs:
            sim = SimulationEngine()
            worker = SDRWorker(cfg, sim)
            if not worker.try_hardware():
                logger.info("Multi-SDR worker falling back to simulation.")
            self._workers.append(worker)
            self._sim_engines.append(sim)
            modes.append(worker.mode)
        return modes

    def start_all(self):
        for w in self._workers:
            w.start()

    def stop_all(self):
        for w in self._workers:
            w.stop()
            w.join(3.0)

    @property
    def workers(self) -> List[SDRWorker]:
        return self._workers


# ── Main SDR Engine facade ─────────────────────────────────────────────────────

class SDREngine:
    """
    Top-level SDR engine façade.
    Creates either a single SDRWorker or a MultiSDRManager depending on mode.
    """

    def __init__(self, config: Optional[SDRConfig] = None):
        self._config = config or SDRConfig()
        self._sim_engine = SimulationEngine()
        self._worker: Optional[SDRWorker] = None
        self._multi: Optional[MultiSDRManager] = None
        self._mode = SDRMode.SIMULATION

    def initialize(self, auto_fallback: bool = True) -> SDRMode:
        """
        Try hardware; fall back to simulation if auto_fallback is True.
        Returns the active SDRMode.
        """
        self._worker = SDRWorker(self._config, self._sim_engine)
        if not self._worker.try_hardware() and not auto_fallback:
            raise RuntimeError("HackRF hardware not found and auto_fallback is disabled.")
        self._mode = self._worker.mode
        logger.info("SDREngine initialized in %s mode.", self._mode.value)
        return self._mode

    @property
    def worker(self) -> Optional[SDRWorker]:
        return self._worker

    @property
    def mode(self) -> SDRMode:
        return self._mode

    @property
    def sim_engine(self) -> SimulationEngine:
        return self._sim_engine

    def start(self):
        if self._worker:
            self._worker.start()

    def stop(self):
        if self._worker:
            self._worker.stop()
            if self._worker.is_alive():
                self._worker.join(5.0)

    def set_config(self, config: SDRConfig):
        self._config = config
        if self._worker:
            self._worker.set_frequency(config.center_frequency_hz)
            self._worker.set_gain(config.lna_gain, config.vga_gain, config.amp_enabled)
            self._worker.set_sample_rate(config.sample_rate_hz)
