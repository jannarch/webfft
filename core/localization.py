"""
core/localization.py
RF source localization using RSSI-based path-loss trilateration.

Single-SDR mode
---------------
The user manually walks to ≥3 positions, records (lat, lon, RSSI) at each,
then this module estimates the transmitter location via nonlinear least-squares.

Multi-SDR mode (TDOA)
---------------------
When multiple synchronised receivers provide timestamps of the same burst,
cross-correlation gives time-difference-of-arrival; TDOA hyperbolic equations
are solved to estimate the source location.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Optional, Tuple

import numpy as np
from scipy.optimize import minimize
from scipy.signal import correlate

from utils.logger import get_logger

logger = get_logger("localization")

# Earth radius in meters
EARTH_RADIUS_M = 6_371_000.0


# ── Coordinate helpers ─────────────────────────────────────────────────────────

def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return distance in metres between two WGS-84 points."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def offset_latlon(lat: float, lon: float, dx_m: float, dy_m: float) -> Tuple[float, float]:
    """Return new (lat, lon) after moving dx_m east and dy_m north."""
    new_lat = lat + math.degrees(dy_m / EARTH_RADIUS_M)
    new_lon = lon + math.degrees(dx_m / (EARTH_RADIUS_M * math.cos(math.radians(lat))))
    return new_lat, new_lon


def latlon_to_xy(ref_lat: float, ref_lon: float, lat: float, lon: float) -> Tuple[float, float]:
    """Convert lat/lon to local Cartesian (x east, y north) in metres."""
    x = EARTH_RADIUS_M * math.cos(math.radians(ref_lat)) * math.radians(lon - ref_lon)
    y = EARTH_RADIUS_M * math.radians(lat - ref_lat)
    return x, y


def xy_to_latlon(ref_lat: float, ref_lon: float, x: float, y: float) -> Tuple[float, float]:
    """Inverse of latlon_to_xy."""
    lat = ref_lat + math.degrees(y / EARTH_RADIUS_M)
    lon = ref_lon + math.degrees(x / (EARTH_RADIUS_M * math.cos(math.radians(ref_lat))))
    return lat, lon


# ── Measurement point ──────────────────────────────────────────────────────────

@dataclass
class MeasPoint:
    """One RSSI measurement at a known location."""
    lat: float
    lon: float
    rssi_dbm: float
    label: str = ""


# ── Result ────────────────────────────────────────────────────────────────────

@dataclass
class LocalizationResult:
    latitude: float
    longitude: float
    confidence_radius_m: float     # 1-σ uncertainty radius
    method: str                    # 'trilateration' | 'tdoa' | 'insufficient_data'
    residual: float                # RMS residual of the fit
    n_points: int
    success: bool


# ── Path-loss model ───────────────────────────────────────────────────────────

class PathLossModel:
    """
    Log-distance path-loss model:
        RSSI(d) = P0 - 10·n·log10(d / d0)
    where n is the path-loss exponent (≈2 in free space, 2.5–4 indoors).
    """

    def __init__(
        self,
        reference_power_dbm: float = -30.0,
        reference_distance_m: float = 1.0,
        path_loss_exponent: float = 2.7,
    ):
        self.P0 = reference_power_dbm
        self.d0 = reference_distance_m
        self.n = path_loss_exponent

    def distance_from_rssi(self, rssi_dbm: float) -> float:
        """Estimate distance in metres from measured RSSI."""
        d = self.d0 * 10.0 ** ((self.P0 - rssi_dbm) / (10.0 * self.n))
        return max(d, 0.1)   # floor at 10 cm

    def rssi_at_distance(self, distance_m: float) -> float:
        """Predict RSSI at a given distance."""
        if distance_m <= 0:
            return self.P0
        return self.P0 - 10.0 * self.n * math.log10(distance_m / self.d0)

    def calibrate(self, known_points: List[Tuple[float, float]]):
        """
        Calibrate P0 and n from a list of (distance_m, rssi_dbm) pairs.
        Requires ≥ 2 points.
        """
        if len(known_points) < 2:
            return
        dists = np.array([p[0] for p in known_points], dtype=float)
        rssis = np.array([p[1] for p in known_points], dtype=float)
        # Linear fit: RSSI = P0 - 10·n·log10(d/d0)
        # y = a + b·x  where x = log10(d/d0), y = RSSI, a = P0, b = -10·n
        x = np.log10(dists / self.d0)
        A = np.column_stack([np.ones_like(x), x])
        result = np.linalg.lstsq(A, rssis, rcond=None)
        a, b = result[0]
        self.P0 = float(a)
        self.n = float(-b / 10.0)
        logger.info("PathLossModel calibrated: P0=%.1f dBm  n=%.2f", self.P0, self.n)


# ── Single-SDR Trilateration ───────────────────────────────────────────────────

class RSSILocalizer:
    """
    Estimate transmitter location from RSSI measurements at ≥3 known positions.
    Uses nonlinear least-squares minimisation (scipy.optimize.minimize).
    """

    def __init__(self, path_loss_model: Optional[PathLossModel] = None):
        self._model = path_loss_model or PathLossModel()

    @property
    def model(self) -> PathLossModel:
        return self._model

    def localize(self, points: List[MeasPoint]) -> LocalizationResult:
        """
        Estimate transmitter coordinates from a list of MeasPoints.

        Returns LocalizationResult (success=False if < 3 points).
        """
        if len(points) < 3:
            logger.warning("Need ≥3 measurement points for trilateration (have %d).", len(points))
            # Fall back to centroid of provided points
            if points:
                lat = sum(p.lat for p in points) / len(points)
                lon = sum(p.lon for p in points) / len(points)
                return LocalizationResult(lat, lon, 9999.0, "insufficient_data", 9999.0, len(points), False)
            return LocalizationResult(0.0, 0.0, 9999.0, "insufficient_data", 9999.0, 0, False)

        # Convert to local Cartesian (metres) with first point as origin
        ref_lat, ref_lon = points[0].lat, points[0].lon
        obs: List[Tuple[float, float, float]] = []   # (x, y, estimated_dist)
        for p in points:
            x, y = latlon_to_xy(ref_lat, ref_lon, p.lat, p.lon)
            d = self._model.distance_from_rssi(p.rssi_dbm)
            obs.append((x, y, d))

        # Initial guess: centroid
        x0 = np.mean([o[0] for o in obs])
        y0 = np.mean([o[1] for o in obs])

        def cost(xy: np.ndarray) -> float:
            px, py = xy
            total = 0.0
            for x, y, d_meas in obs:
                d_est = math.sqrt((px - x) ** 2 + (py - y) ** 2)
                total += (d_est - d_meas) ** 2
            return total

        result = minimize(cost, [x0, y0], method="Nelder-Mead",
                          options={"xatol": 1.0, "fatol": 1.0, "maxiter": 5000})
        px, py = result.x
        tx_lat, tx_lon = xy_to_latlon(ref_lat, ref_lon, px, py)

        # Residual (RMS distance error)
        residuals = []
        for x, y, d_meas in obs:
            d_est = math.sqrt((px - x) ** 2 + (py - y) ** 2)
            residuals.append((d_est - d_meas) ** 2)
        rms = math.sqrt(sum(residuals) / len(residuals))

        # Confidence radius heuristic (1-sigma ≈ RMS residual)
        confidence = max(rms, 10.0)

        logger.info("Trilateration: lat=%.6f  lon=%.6f  RMS=%.1f m  n_pts=%d",
                    tx_lat, tx_lon, rms, len(points))

        return LocalizationResult(
            latitude=tx_lat,
            longitude=tx_lon,
            confidence_radius_m=confidence,
            method="trilateration",
            residual=rms,
            n_points=len(points),
            success=result.success,
        )


# ── TDOA Localizer ─────────────────────────────────────────────────────────────

SPEED_OF_LIGHT = 3e8  # m/s for RF


class TDOALocalizer:
    """
    Time-Difference-of-Arrival localization for multi-SDR setups.
    Each receiver provides IQ samples of the same burst event; cross-correlation
    gives the sample-delay → TDOA → range difference → hyperbolic intersection.

    Requires ≥3 receivers for a 2-D solution.
    """

    def __init__(self, receiver_positions: List[Tuple[float, float]]):
        """
        Parameters
        ----------
        receiver_positions: list of (lat, lon) tuples for each receiver.
        """
        self._positions = receiver_positions

    def compute_tdoa(
        self,
        samples_list: List[np.ndarray],
        sample_rate_hz: float,
        reference_idx: int = 0,
    ) -> List[float]:
        """
        Cross-correlate each channel against the reference channel.
        Returns list of time-delays in seconds (TDOA[i] relative to reference).
        """
        ref = samples_list[reference_idx]
        tdoas: List[float] = []
        for i, sig in enumerate(samples_list):
            if i == reference_idx:
                tdoas.append(0.0)
                continue
            corr = correlate(sig, ref, mode="full")
            lag = int(np.argmax(np.abs(corr))) - (len(ref) - 1)
            tdoas.append(lag / sample_rate_hz)
        return tdoas

    def localize(
        self,
        samples_list: List[np.ndarray],
        sample_rate_hz: float,
    ) -> LocalizationResult:
        n = len(samples_list)
        if n < 3 or n != len(self._positions):
            return LocalizationResult(0.0, 0.0, 9999.0, "insufficient_data", 9999.0, n, False)

        tdoas = self.compute_tdoa(samples_list, sample_rate_hz)
        ref_lat, ref_lon = self._positions[0]

        # Convert all positions to local Cartesian
        rx_xy = []
        for lat, lon in self._positions:
            x, y = latlon_to_xy(ref_lat, ref_lon, lat, lon)
            rx_xy.append((x, y))

        # Build range-difference constraints
        range_diffs = [t * SPEED_OF_LIGHT for t in tdoas]  # in metres

        def cost(xy: np.ndarray) -> float:
            px, py = xy
            d0 = math.sqrt((px - rx_xy[0][0]) ** 2 + (py - rx_xy[0][1]) ** 2)
            total = 0.0
            for i in range(1, n):
                di = math.sqrt((px - rx_xy[i][0]) ** 2 + (py - rx_xy[i][1]) ** 2)
                total += (di - d0 - range_diffs[i]) ** 2
            return total

        x0 = np.mean([p[0] for p in rx_xy])
        y0 = np.mean([p[1] for p in rx_xy])
        result = minimize(cost, [x0, y0], method="Nelder-Mead",
                          options={"xatol": 1.0, "fatol": 1.0, "maxiter": 10000})
        px, py = result.x
        tx_lat, tx_lon = xy_to_latlon(ref_lat, ref_lon, px, py)

        residuals = []
        d0 = math.sqrt((px - rx_xy[0][0]) ** 2 + (py - rx_xy[0][1]) ** 2)
        for i in range(1, n):
            di = math.sqrt((px - rx_xy[i][0]) ** 2 + (py - rx_xy[i][1]) ** 2)
            residuals.append((di - d0 - range_diffs[i]) ** 2)
        rms = math.sqrt(sum(residuals) / len(residuals)) if residuals else 0.0

        return LocalizationResult(
            latitude=tx_lat,
            longitude=tx_lon,
            confidence_radius_m=max(rms, 5.0),
            method="tdoa",
            residual=rms,
            n_points=n,
            success=result.success,
        )
