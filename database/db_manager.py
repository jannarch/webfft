"""
database/db_manager.py
SQLite database manager for SDR Monitor.
Thread-safe operations via threading.Lock.
"""

import sqlite3
import threading
import os
import uuid
from datetime import datetime
from typing import List, Optional
from contextlib import contextmanager

from database.models import Detection, Measurement, Recording, LocationPoint, Session
from utils.logger import get_logger

logger = get_logger("db_manager")


class DatabaseManager:
    """Thread-safe SQLite database manager."""

    def __init__(self, db_path: str = "data/sdr_monitor.db"):
        self._db_path = db_path
        self._lock = threading.Lock()
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self._initialize_schema()
        logger.info("Database initialized at: %s", db_path)

    # ── Context manager ────────────────────────────────────────────────────────
    @contextmanager
    def _connection(self):
        """Provide a transactional database connection."""
        conn = sqlite3.connect(self._db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            with self._lock:
                yield conn
                conn.commit()
        except Exception as e:
            conn.rollback()
            logger.error("Database error: %s", e)
            raise
        finally:
            conn.close()

    # ── Schema ─────────────────────────────────────────────────────────────────
    def _initialize_schema(self):
        """Create all required tables if they do not exist."""
        schema = """
        CREATE TABLE IF NOT EXISTS sessions (
            id          TEXT PRIMARY KEY,
            start_time  TEXT NOT NULL,
            end_time    TEXT,
            device_mode TEXT NOT NULL DEFAULT 'simulation',
            notes       TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS detections (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            frequency_hz    REAL NOT NULL,
            power_dbm       REAL NOT NULL,
            bandwidth_hz    REAL NOT NULL DEFAULT 0,
            timestamp       TEXT NOT NULL,
            duration_ms     REAL NOT NULL DEFAULT 0,
            status          TEXT NOT NULL DEFAULT 'active',
            classification  TEXT NOT NULL DEFAULT 'unknown',
            session_id      TEXT,
            notes           TEXT DEFAULT '',
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );

        CREATE TABLE IF NOT EXISTS measurements (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            frequency_hz    REAL NOT NULL,
            power_dbm       REAL NOT NULL,
            noise_floor_dbm REAL NOT NULL DEFAULT -90.0,
            snr_db          REAL NOT NULL DEFAULT 0.0,
            timestamp       TEXT NOT NULL,
            session_id      TEXT,
            latitude        REAL,
            longitude       REAL,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );

        CREATE TABLE IF NOT EXISTS recordings (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            filename            TEXT NOT NULL,
            center_frequency_hz REAL NOT NULL,
            sample_rate_hz      REAL NOT NULL,
            duration_sec        REAL NOT NULL DEFAULT 0,
            file_size_bytes     INTEGER NOT NULL DEFAULT 0,
            timestamp           TEXT NOT NULL,
            session_id          TEXT,
            notes               TEXT DEFAULT '',
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );

        CREATE TABLE IF NOT EXISTS location_points (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            latitude        REAL NOT NULL,
            longitude       REAL NOT NULL,
            frequency_hz    REAL NOT NULL,
            rssi_dbm        REAL NOT NULL,
            timestamp       TEXT NOT NULL,
            session_id      TEXT,
            label           TEXT DEFAULT '',
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_det_freq    ON detections (frequency_hz);
        CREATE INDEX IF NOT EXISTS idx_det_ts      ON detections (timestamp);
        CREATE INDEX IF NOT EXISTS idx_meas_freq   ON measurements (frequency_hz);
        CREATE INDEX IF NOT EXISTS idx_meas_ts     ON measurements (timestamp);
        CREATE INDEX IF NOT EXISTS idx_loc_session ON location_points (session_id);
        """
        with self._connection() as conn:
            conn.executescript(schema)

    # ── Sessions ───────────────────────────────────────────────────────────────
    def create_session(self, device_mode: str = "simulation") -> str:
        session_id = str(uuid.uuid4())[:8].upper()
        now = datetime.now().isoformat()
        with self._connection() as conn:
            conn.execute(
                "INSERT INTO sessions (id, start_time, device_mode) VALUES (?, ?, ?)",
                (session_id, now, device_mode),
            )
        logger.info("Session created: %s [%s]", session_id, device_mode)
        return session_id

    def close_session(self, session_id: str):
        now = datetime.now().isoformat()
        with self._connection() as conn:
            conn.execute(
                "UPDATE sessions SET end_time = ? WHERE id = ?",
                (now, session_id),
            )

    def get_all_sessions(self) -> list:
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM sessions ORDER BY start_time DESC"
            ).fetchall()
        return [dict(r) for r in rows]

    # ── Detections ─────────────────────────────────────────────────────────────
    def save_detection(self, detection: Detection) -> int:
        with self._connection() as conn:
            cur = conn.execute(
                """INSERT INTO detections
                   (frequency_hz, power_dbm, bandwidth_hz, timestamp,
                    duration_ms, status, classification, session_id, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    detection.frequency_hz,
                    detection.power_dbm,
                    detection.bandwidth_hz,
                    detection.timestamp,
                    detection.duration_ms,
                    detection.status,
                    detection.classification,
                    detection.session_id,
                    detection.notes,
                ),
            )
            return cur.lastrowid

    def update_detection(self, detection: Detection):
        with self._connection() as conn:
            conn.execute(
                """UPDATE detections
                   SET power_dbm=?, duration_ms=?, status=?, classification=?, notes=?
                   WHERE id=?""",
                (
                    detection.power_dbm,
                    detection.duration_ms,
                    detection.status,
                    detection.classification,
                    detection.notes,
                    detection.id,
                ),
            )

    def get_detections(
        self,
        session_id: Optional[str] = None,
        freq_min: Optional[float] = None,
        freq_max: Optional[float] = None,
        limit: int = 500,
    ) -> List[Detection]:
        query = "SELECT * FROM detections WHERE 1=1"
        params: list = []
        if session_id:
            query += " AND session_id = ?"
            params.append(session_id)
        if freq_min is not None:
            query += " AND frequency_hz >= ?"
            params.append(freq_min)
        if freq_max is not None:
            query += " AND frequency_hz <= ?"
            params.append(freq_max)
        query += " ORDER BY timestamp DESC LIMIT ?"
        params.append(limit)

        with self._connection() as conn:
            rows = conn.execute(query, params).fetchall()
        return [Detection.from_row(tuple(r)) for r in rows]

    def get_all_detections(self) -> List[Detection]:
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM detections ORDER BY timestamp DESC"
            ).fetchall()
        return [Detection.from_row(tuple(r)) for r in rows]

    # ── Measurements ───────────────────────────────────────────────────────────
    def save_measurement(self, measurement: Measurement):
        with self._connection() as conn:
            conn.execute(
                """INSERT INTO measurements
                   (frequency_hz, power_dbm, noise_floor_dbm, snr_db,
                    timestamp, session_id, latitude, longitude)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    measurement.frequency_hz,
                    measurement.power_dbm,
                    measurement.noise_floor_dbm,
                    measurement.snr_db,
                    measurement.timestamp,
                    measurement.session_id,
                    measurement.latitude,
                    measurement.longitude,
                ),
            )

    def get_measurements(self, session_id: Optional[str] = None, limit: int = 1000) -> List[Measurement]:
        query = "SELECT * FROM measurements"
        params: list = []
        if session_id:
            query += " WHERE session_id = ?"
            params.append(session_id)
        query += " ORDER BY timestamp DESC LIMIT ?"
        params.append(limit)
        with self._connection() as conn:
            rows = conn.execute(query, params).fetchall()
        return [Measurement.from_row(tuple(r)) for r in rows]

    # ── Recordings ─────────────────────────────────────────────────────────────
    def save_recording(self, recording: Recording) -> int:
        with self._connection() as conn:
            cur = conn.execute(
                """INSERT INTO recordings
                   (filename, center_frequency_hz, sample_rate_hz, duration_sec,
                    file_size_bytes, timestamp, session_id, notes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    recording.filename,
                    recording.center_frequency_hz,
                    recording.sample_rate_hz,
                    recording.duration_sec,
                    recording.file_size_bytes,
                    recording.timestamp,
                    recording.session_id,
                    recording.notes,
                ),
            )
            return cur.lastrowid

    def get_recordings(self) -> List[Recording]:
        with self._connection() as conn:
            rows = conn.execute(
                "SELECT * FROM recordings ORDER BY timestamp DESC"
            ).fetchall()
        return [Recording.from_row(tuple(r)) for r in rows]

    def update_recording(self, rec_id: int, duration_sec: float, file_size_bytes: int):
        with self._connection() as conn:
            conn.execute(
                "UPDATE recordings SET duration_sec=?, file_size_bytes=? WHERE id=?",
                (duration_sec, file_size_bytes, rec_id),
            )

    # ── Location Points ────────────────────────────────────────────────────────
    def save_location_point(self, point: LocationPoint) -> int:
        with self._connection() as conn:
            cur = conn.execute(
                """INSERT INTO location_points
                   (latitude, longitude, frequency_hz, rssi_dbm, timestamp, session_id, label)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    point.latitude,
                    point.longitude,
                    point.frequency_hz,
                    point.rssi_dbm,
                    point.timestamp,
                    point.session_id,
                    point.label,
                ),
            )
            return cur.lastrowid

    def get_location_points(self, session_id: Optional[str] = None, freq_hz: Optional[float] = None) -> List[LocationPoint]:
        query = "SELECT * FROM location_points WHERE 1=1"
        params: list = []
        if session_id:
            query += " AND session_id = ?"
            params.append(session_id)
        if freq_hz is not None:
            query += " AND ABS(frequency_hz - ?) < 100000"   # ±100 kHz tolerance
            params.append(freq_hz)
        query += " ORDER BY timestamp ASC"
        with self._connection() as conn:
            rows = conn.execute(query, params).fetchall()
        return [LocationPoint.from_row(tuple(r)) for r in rows]

    def delete_location_point(self, point_id: int):
        with self._connection() as conn:
            conn.execute("DELETE FROM location_points WHERE id = ?", (point_id,))

    # ── Statistics ─────────────────────────────────────────────────────────────
    def get_statistics(self) -> dict:
        with self._connection() as conn:
            total_det = conn.execute("SELECT COUNT(*) FROM detections").fetchone()[0]
            suspect = conn.execute(
                "SELECT COUNT(*) FROM detections WHERE classification='suspect'"
            ).fetchone()[0]
            total_meas = conn.execute("SELECT COUNT(*) FROM measurements").fetchone()[0]
            total_rec = conn.execute("SELECT COUNT(*) FROM recordings").fetchone()[0]
        return {
            "total_detections": total_det,
            "suspect_count": suspect,
            "total_measurements": total_meas,
            "total_recordings": total_rec,
        }

    def vacuum(self):
        """Compact the database."""
        with self._connection() as conn:
            conn.execute("VACUUM")
