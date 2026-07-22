"""
core/iq_recorder.py
IQ data recording and playback for HackRF One / SDR Monitor.

File format:
  *.iq         – raw binary, complex64 (float32 I + float32 Q interleaved)
  *.iq.json    – metadata sidecar (sample rate, center freq, timestamp, …)
"""

from __future__ import annotations

import os
import json
import time
import threading
import numpy as np
from datetime import datetime
from typing import Optional, Callable

from utils.logger import get_logger

logger = get_logger("iq_recorder")

DTYPE = np.complex64
BYTES_PER_SAMPLE = 8          # complex64 = 4 bytes I + 4 bytes Q


class IQMetadata:
    """Sidecar metadata for one IQ recording."""

    def __init__(
        self,
        center_frequency_hz: float,
        sample_rate_hz: float,
        timestamp: str,
        filename: str,
        notes: str = "",
    ):
        self.center_frequency_hz = center_frequency_hz
        self.sample_rate_hz = sample_rate_hz
        self.timestamp = timestamp
        self.filename = filename
        self.duration_sec: float = 0.0
        self.total_samples: int = 0
        self.file_size_bytes: int = 0
        self.notes = notes

    def to_dict(self) -> dict:
        return {
            "center_frequency_hz": self.center_frequency_hz,
            "center_frequency_mhz": round(self.center_frequency_hz / 1e6, 6),
            "sample_rate_hz": self.sample_rate_hz,
            "timestamp": self.timestamp,
            "filename": self.filename,
            "duration_sec": round(self.duration_sec, 3),
            "total_samples": self.total_samples,
            "file_size_bytes": self.file_size_bytes,
            "notes": self.notes,
        }

    def save(self, path: str):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, indent=2)

    @staticmethod
    def load(path: str) -> "IQMetadata":
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        m = IQMetadata(
            center_frequency_hz=d["center_frequency_hz"],
            sample_rate_hz=d["sample_rate_hz"],
            timestamp=d["timestamp"],
            filename=d["filename"],
            notes=d.get("notes", ""),
        )
        m.duration_sec = d.get("duration_sec", 0.0)
        m.total_samples = d.get("total_samples", 0)
        m.file_size_bytes = d.get("file_size_bytes", 0)
        return m


# ── Recorder ──────────────────────────────────────────────────────────────────

class IQRecorder:
    """
    Writes incoming IQ sample arrays to a binary file in real-time.

    Usage
    -----
    recorder = IQRecorder(output_dir="recordings")
    recorder.start(center_freq_hz=100e6, sample_rate_hz=2e6)
    recorder.write(samples)   # called from SDRWorker
    recorder.stop()
    meta = recorder.metadata
    """

    def __init__(self, output_dir: str = "recordings", auto_split_mb: float = 500.0):
        self._output_dir = output_dir
        self._auto_split_bytes = int(auto_split_mb * 1024 * 1024)
        self._file: Optional[object] = None
        self._metadata: Optional[IQMetadata] = None
        self._lock = threading.Lock()
        self._active = False
        self._start_time: float = 0.0
        self._bytes_written: int = 0
        self._samples_written: int = 0
        os.makedirs(output_dir, exist_ok=True)

    @property
    def is_active(self) -> bool:
        return self._active

    @property
    def metadata(self) -> Optional[IQMetadata]:
        return self._metadata

    @property
    def bytes_written(self) -> int:
        return self._bytes_written

    @property
    def elapsed_sec(self) -> float:
        if self._active:
            return time.time() - self._start_time
        return self._metadata.duration_sec if self._metadata else 0.0

    def start(
        self,
        center_freq_hz: float,
        sample_rate_hz: float,
        notes: str = "",
    ) -> str:
        """Open a new IQ file and begin recording. Returns the file path."""
        with self._lock:
            if self._active:
                raise RuntimeError("Recorder already active – call stop() first.")

            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            freq_mhz = center_freq_hz / 1e6
            filename = f"iq_{freq_mhz:.3f}MHz_{ts}.iq"
            filepath = os.path.join(self._output_dir, filename)

            self._metadata = IQMetadata(
                center_frequency_hz=center_freq_hz,
                sample_rate_hz=sample_rate_hz,
                timestamp=datetime.now().isoformat(),
                filename=filename,
                notes=notes,
            )
            self._file = open(filepath, "wb")
            self._active = True
            self._start_time = time.time()
            self._bytes_written = 0
            self._samples_written = 0

            logger.info("Recording started: %s  (center=%.3f MHz  sr=%.1f ksps)",
                        filepath, freq_mhz, sample_rate_hz / 1e3)
            return filepath

    def write(self, samples: np.ndarray):
        """Append complex64 samples to the open file. Thread-safe."""
        if not self._active or self._file is None:
            return
        with self._lock:
            data = samples.astype(DTYPE)
            self._file.write(data.tobytes())
            n_bytes = data.nbytes
            self._bytes_written += n_bytes
            self._samples_written += len(samples)

            # Auto-split check (basic; full split would open a new file)
            if self._auto_split_bytes > 0 and self._bytes_written >= self._auto_split_bytes:
                logger.warning("Recording reached auto-split size (%.1f MB). "
                               "Stop and restart to continue in a new file.",
                               self._auto_split_bytes / 1024 / 1024)

    def stop(self) -> Optional[IQMetadata]:
        """Flush, close the file, and save metadata sidecar. Returns metadata."""
        with self._lock:
            if not self._active:
                return self._metadata
            self._active = False
            duration = time.time() - self._start_time
            if self._file:
                self._file.flush()
                self._file.close()
                self._file = None

            if self._metadata:
                self._metadata.duration_sec = round(duration, 3)
                self._metadata.total_samples = self._samples_written
                self._metadata.file_size_bytes = self._bytes_written
                meta_path = os.path.join(
                    self._output_dir, self._metadata.filename + ".json"
                )
                self._metadata.save(meta_path)
                logger.info("Recording stopped: %.1f s  %d samples  %.2f MB",
                            duration, self._samples_written,
                            self._bytes_written / 1024 / 1024)

        return self._metadata


# ── Playback Worker ───────────────────────────────────────────────────────────

class IQPlaybackWorker(threading.Thread):
    """
    Reads a recorded IQ file and re-emits samples as if coming from hardware.
    """

    CHUNK_SAMPLES = 4096

    def __init__(self, filepath: str, metadata: IQMetadata):
        super().__init__()
        self.daemon = True
        self._filepath = filepath
        self._meta = metadata
        self._running = False
        self._loop = False
        
        self.on_samples_ready: Optional[Callable[[np.ndarray, float, float, float], None]] = None
        self.on_progress: Optional[Callable[[float], None]] = None
        self.on_finished: Optional[Callable[[], None]] = None

    def set_loop(self, loop: bool):
        self._loop = loop

    def stop(self):
        self._running = False

    def run(self):
        self._running = True
        total_bytes = os.path.getsize(self._filepath)
        bytes_read = 0
        interval = self.CHUNK_SAMPLES / self._meta.sample_rate_hz

        try:
            while self._running:
                with open(self._filepath, "rb") as f:
                    while self._running:
                        raw = f.read(self.CHUNK_SAMPLES * BYTES_PER_SAMPLE)
                        if not raw:
                            break
                        samples = np.frombuffer(raw, dtype=DTYPE).copy()
                        if self.on_samples_ready:
                            self.on_samples_ready(
                                samples,
                                self._meta.center_frequency_hz,
                                self._meta.sample_rate_hz,
                                time.time()
                            )
                        
                        bytes_read += len(raw)
                        pct = (bytes_read / total_bytes) * 100.0 if total_bytes > 0 else 0
                        if self.on_progress:
                            self.on_progress(pct)
                            
                        time.sleep(interval)
                
                if not self._loop:
                    break
                bytes_read = 0

            if self.on_finished:
                self.on_finished()
        except Exception as e:
            logger.error(f"Playback error: {e}")
