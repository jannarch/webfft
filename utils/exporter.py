"""
utils/exporter.py
Export SDR Monitor data to CSV and JSON formats.
"""

import csv
import json
import os
from datetime import datetime
from typing import List

from database.models import Detection, Measurement, Recording
from utils.logger import get_logger

logger = get_logger("exporter")


def _ensure_dir(path: str):
    os.makedirs(os.path.dirname(path) if os.path.dirname(path) else ".", exist_ok=True)


class DataExporter:
    """Handles CSV and JSON export of SDR data."""

    # ── Detections ─────────────────────────────────────────────────────────────
    @staticmethod
    def detections_to_csv(detections: List[Detection], filepath: str) -> str:
        _ensure_dir(filepath)
        fieldnames = [
            "id", "frequency_hz", "frequency_mhz", "power_dbm",
            "bandwidth_hz", "timestamp", "duration_ms",
            "status", "classification", "session_id", "notes",
        ]
        with open(filepath, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for d in detections:
                row = d.to_dict()
                row["frequency_mhz"] = round(d.frequency_hz / 1e6, 6)
                writer.writerow({k: row.get(k, "") for k in fieldnames})
        logger.info("Exported %d detections → CSV: %s", len(detections), filepath)
        return filepath

    @staticmethod
    def detections_to_json(detections: List[Detection], filepath: str) -> str:
        _ensure_dir(filepath)
        data = {
            "exported_at": datetime.now().isoformat(),
            "count": len(detections),
            "detections": [d.to_dict() for d in detections],
        }
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        logger.info("Exported %d detections → JSON: %s", len(detections), filepath)
        return filepath

    # ── Measurements ───────────────────────────────────────────────────────────
    @staticmethod
    def measurements_to_csv(measurements: List[Measurement], filepath: str) -> str:
        _ensure_dir(filepath)
        fieldnames = [
            "id", "frequency_hz", "frequency_mhz", "power_dbm",
            "noise_floor_dbm", "snr_db", "timestamp",
            "session_id", "latitude", "longitude",
        ]
        with open(filepath, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for m in measurements:
                row = m.to_dict()
                row["frequency_mhz"] = round(m.frequency_hz / 1e6, 6)
                writer.writerow({k: row.get(k, "") for k in fieldnames})
        logger.info("Exported %d measurements → CSV: %s", len(measurements), filepath)
        return filepath

    @staticmethod
    def measurements_to_json(measurements: List[Measurement], filepath: str) -> str:
        _ensure_dir(filepath)
        data = {
            "exported_at": datetime.now().isoformat(),
            "count": len(measurements),
            "measurements": [m.to_dict() for m in measurements],
        }
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        logger.info("Exported %d measurements → JSON: %s", len(measurements), filepath)
        return filepath

    # ── Recordings metadata ────────────────────────────────────────────────────
    @staticmethod
    def recordings_to_csv(recordings: List[Recording], filepath: str) -> str:
        _ensure_dir(filepath)
        fieldnames = [
            "id", "filename", "center_frequency_hz", "center_frequency_mhz",
            "sample_rate_hz", "duration_sec", "file_size_bytes",
            "timestamp", "session_id", "notes",
        ]
        with open(filepath, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for r in recordings:
                row = r.to_dict()
                row["center_frequency_mhz"] = round(r.center_frequency_hz / 1e6, 6)
                writer.writerow({k: row.get(k, "") for k in fieldnames})
        logger.info("Exported %d recordings → CSV: %s", len(recordings), filepath)
        return filepath

    # ── Convenience: auto-generate filename ────────────────────────────────────
    @staticmethod
    def auto_filename(prefix: str, ext: str, export_dir: str = "exports") -> str:
        os.makedirs(export_dir, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        return os.path.join(export_dir, f"{prefix}_{ts}.{ext}")
