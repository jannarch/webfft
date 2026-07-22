"""
database/models.py
Dataclass models for SDR Monitor database entities.
"""

from __future__ import annotations
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Optional
import json


@dataclass
class Detection:
    """Represents a single detected signal event."""
    id: Optional[int]
    frequency_hz: float
    power_dbm: float
    bandwidth_hz: float
    timestamp: str
    duration_ms: float
    status: str            # 'active' | 'closed'
    classification: str    # 'licensed' | 'suspect' | 'unknown'
    session_id: str
    notes: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_row(row: tuple) -> Detection:
        return Detection(
            id=row[0],
            frequency_hz=row[1],
            power_dbm=row[2],
            bandwidth_hz=row[3],
            timestamp=row[4],
            duration_ms=row[5],
            status=row[6],
            classification=row[7],
            session_id=row[8],
            notes=row[9] if len(row) > 9 else "",
        )


@dataclass
class Measurement:
    """A single power-level measurement at a given frequency."""
    id: Optional[int]
    frequency_hz: float
    power_dbm: float
    noise_floor_dbm: float
    snr_db: float
    timestamp: str
    session_id: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_row(row: tuple) -> Measurement:
        return Measurement(
            id=row[0],
            frequency_hz=row[1],
            power_dbm=row[2],
            noise_floor_dbm=row[3],
            snr_db=row[4],
            timestamp=row[5],
            session_id=row[6],
            latitude=row[7] if len(row) > 7 else None,
            longitude=row[8] if len(row) > 8 else None,
        )


@dataclass
class Recording:
    """Metadata for an IQ data recording file."""
    id: Optional[int]
    filename: str
    center_frequency_hz: float
    sample_rate_hz: float
    duration_sec: float
    file_size_bytes: int
    timestamp: str
    session_id: str
    notes: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_row(row: tuple) -> Recording:
        return Recording(
            id=row[0],
            filename=row[1],
            center_frequency_hz=row[2],
            sample_rate_hz=row[3],
            duration_sec=row[4],
            file_size_bytes=row[5],
            timestamp=row[6],
            session_id=row[7],
            notes=row[8] if len(row) > 8 else "",
        )


@dataclass
class LocationPoint:
    """A manually entered measurement point for localization."""
    id: Optional[int]
    latitude: float
    longitude: float
    frequency_hz: float
    rssi_dbm: float
    timestamp: str
    session_id: str
    label: str = ""

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_row(row: tuple) -> LocationPoint:
        return LocationPoint(
            id=row[0],
            latitude=row[1],
            longitude=row[2],
            frequency_hz=row[3],
            rssi_dbm=row[4],
            timestamp=row[5],
            session_id=row[6],
            label=row[7] if len(row) > 7 else "",
        )


@dataclass
class Session:
    """Monitoring session metadata."""
    id: str
    start_time: str
    end_time: Optional[str]
    device_mode: str       # 'hardware' | 'simulation'
    notes: str = ""

    def to_dict(self) -> dict:
        return asdict(self)
