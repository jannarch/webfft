"""
database/schedule_manager.py
Manager for parsing EiBi / short-wave schedule databases (e.g., sked-a26.csv)
and serving station lookup queries.
"""

import os
import csv
import sqlite3
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional
from database.country_coords import get_country_coords
from utils.logger import get_logger

logger = get_logger("schedule_manager")

class ScheduleManager:
    """Manages shortwave station schedule data loaded from EiBi CSV files."""

    def __init__(self, csv_path: str = "database/sked-a26.csv", db_path: str = "data/sdr_monitor.db"):
        self.csv_path = csv_path
        self.db_path = db_path
        self._memory_schedules: List[Dict[str, Any]] = []
        self._is_loaded = False
        self.load_schedules()

    def load_schedules(self):
        """Parse CSV and load schedules into memory for high-speed queries."""
        if not os.path.exists(self.csv_path):
            logger.warning("Schedule CSV not found at %s", self.csv_path)
            return

        schedules = []
        try:
            with open(self.csv_path, mode="r", encoding="latin-1") as f:
                lines = f.readlines()

            for line in lines:
                line = line.strip()
                if not line or line.startswith("kHz:") or line.startswith("#"):
                    continue

                parts = line.split(";")
                if len(parts) < 5:
                    continue

                freq_str = parts[0].strip()
                time_str = parts[1].strip() if len(parts) > 1 else ""
                days_str = parts[2].strip() if len(parts) > 2 else ""
                itu_str = parts[3].strip() if len(parts) > 3 else ""
                station_str = parts[4].strip() if len(parts) > 4 else ""
                lang_str = parts[5].strip() if len(parts) > 5 else ""
                target_str = parts[6].strip() if len(parts) > 6 else ""
                remarks_str = parts[7].strip() if len(parts) > 7 else ""
                power_str = parts[8].strip() if len(parts) > 8 else ""

                if not freq_str or not station_str:
                    continue

                try:
                    freq_khz = float(freq_str)
                    freq_hz = freq_khz * 1000.0
                except ValueError:
                    continue

                # Parse UTC start/stop minutes
                start_min = 0
                stop_min = 1440
                if "-" in time_str:
                    t_parts = time_str.split("-")
                    if len(t_parts) == 2 and len(t_parts[0]) == 4 and len(t_parts[1]) == 4:
                        try:
                            start_min = int(t_parts[0][:2]) * 60 + int(t_parts[0][2:])
                            stop_min = int(t_parts[1][:2]) * 60 + int(t_parts[1][2:])
                            if stop_min == 0:
                                stop_min = 1440
                        except ValueError:
                            pass

                coords = get_country_coords(itu_str)
                lat = coords[0] if coords else None
                lon = coords[1] if coords else None

                schedules.append({
                    "frequency_khz": freq_khz,
                    "frequency_hz": freq_hz,
                    "time_str": time_str,
                    "start_min": start_min,
                    "stop_min": stop_min,
                    "days": days_str,
                    "itu": itu_str,
                    "station": station_str,
                    "language": lang_str,
                    "target": target_str,
                    "remarks": remarks_str,
                    "power": power_str,
                    "lat": lat,
                    "lon": lon,
                })

            self._memory_schedules = schedules
            self._is_loaded = True
            logger.info("Successfully loaded %d schedule records from %s", len(schedules), self.csv_path)

        except Exception as e:
            logger.error("Failed to parse schedule CSV %s: %s", self.csv_path, e)

    @staticmethod
    def _get_current_utc_minutes(dt: Optional[datetime] = None) -> tuple[int, int]:
        """Returns (day_of_week 1-7, total_minutes_from_midnight)."""
        if dt is None:
            dt = datetime.now(timezone.utc)
        dow = dt.isoweekday() # 1=Mon, ..., 7=Sun
        total_mins = dt.hour * 60 + dt.minute
        return dow, total_mins

    def lookup_frequency(
        self,
        freq_hz: float,
        tolerance_hz: float = 5000.0,
        dt: Optional[datetime] = None,
        filter_active_time: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Find stations active around a target frequency (in Hz).
        tolerance_hz: search bandwidth (default ±5 kHz).
        """
        if not self._is_loaded:
            return []

        dow, cur_mins = self._get_current_utc_minutes(dt)
        results = []

        min_f = freq_hz - tolerance_hz
        max_f = freq_hz + tolerance_hz

        for item in self._memory_schedules:
            if min_f <= item["frequency_hz"] <= max_f:
                if filter_active_time:
                    # Check time overlap
                    s_min = item["start_min"]
                    e_min = item["stop_min"]
                    if s_min <= e_min:
                        is_active = s_min <= cur_mins <= e_min
                    else: # Over midnight
                        is_active = cur_mins >= s_min or cur_mins <= e_min
                    if not is_active:
                        continue

                    # Check day of week if specified
                    if item["days"]:
                        if str(dow) not in item["days"]:
                            continue

                results.append(item)

        # Sort by proximity to requested frequency
        results.sort(key=lambda x: abs(x["frequency_hz"] - freq_hz))
        return results

    def lookup_range(
        self,
        min_freq_hz: float,
        max_freq_hz: float,
        dt: Optional[datetime] = None,
        filter_active_time: bool = True,
        max_results: int = 50
    ) -> List[Dict[str, Any]]:
        """
        Find all stations active within a frequency band range [min_freq_hz, max_freq_hz].
        Useful for rendering station markers on waterfall.
        """
        if not self._is_loaded:
            return []

        dow, cur_mins = self._get_current_utc_minutes(dt)
        results = []

        for item in self._memory_schedules:
            if min_freq_hz <= item["frequency_hz"] <= max_freq_hz:
                if filter_active_time:
                    s_min = item["start_min"]
                    e_min = item["stop_min"]
                    if s_min <= e_min:
                        is_active = s_min <= cur_mins <= e_min
                    else:
                        is_active = cur_mins >= s_min or cur_mins <= e_min
                    if not is_active:
                        continue

                    if item["days"] and str(dow) not in item["days"]:
                        continue

                results.append(item)

        if len(results) > max_results:
            results = results[:max_results]
        return results

    def search_stations(
        self,
        query: str,
        dt: Optional[datetime] = None,
        filter_active_time: bool = False,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        """Search schedule database by keyword in station, ITU, language, or target."""
        if not self._is_loaded or not query:
            return []

        q = query.lower()
        dow, cur_mins = self._get_current_utc_minutes(dt)
        results = []

        for item in self._memory_schedules:
            match = (
                q in item["station"].lower() or
                q in item["itu"].lower() or
                q in item["language"].lower() or
                q in item["target"].lower() or
                q in str(int(item["frequency_khz"]))
            )
            if match:
                if filter_active_time:
                    s_min = item["start_min"]
                    e_min = item["stop_min"]
                    if s_min <= e_min:
                        is_active = s_min <= cur_mins <= e_min
                    else:
                        is_active = cur_mins >= s_min or cur_mins <= e_min
                    if not is_active:
                        continue

                results.append(item)
                if len(results) >= limit:
                    break

        return results
