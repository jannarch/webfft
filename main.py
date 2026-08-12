import asyncio
import os
import time
import logging
import threading
import struct
import numpy as np
from typing import Dict, Any, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from core.sdr_engine import SDREngine, SDRConfig, ScanMode
from core.signal_processor import SignalProcessor
from core.iq_recorder import IQRecorder
from core.localization import MeasPoint, PathLossModel, RSSILocalizer
from core.audio_demodulator import AudioDemodulator
from database.db_manager import DatabaseManager
from database.models import Detection
from utils.logger import setup_logger, get_logger

# Initialize logging
setup_logger(log_level="DEBUG")
logger = get_logger("web_backend")

# Application State
app = FastAPI(title="Web-SDR Monitor")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global variables for the backend services
sdr_engine = SDREngine()
signal_processor = SignalProcessor()
db_manager = DatabaseManager()
iq_recorder = IQRecorder()

# Active session ID
_session_id: str = None

# Shared state for latest spectrum frame (thread-safe updates)
latest_frame: Dict[str, Any] = {}
frame_lock = threading.Lock()
localization_points: List[Dict[str, Any]] = []

# Audio State
audio_demod = AudioDemodulator()
audio_target_freq_hz: Optional[float] = None
audio_mode: str = "FM"
audio_queues: List[asyncio.Queue] = []
audio_loop: Optional[asyncio.AbstractEventLoop] = None

# Models
class ConfigPayload(BaseModel):
    center_frequency_hz: float = None
    sample_rate_hz: float = None
    lna_gain: int = None
    vga_gain: int = None
    amp_enabled: bool = None
    scan_mode: str = None
    sweep_start_hz: float = None
    sweep_stop_hz: float = None
    sweep_step_hz: float = None
    dwell_time_ms: float = None
    threshold_db: float = None
    min_snr_db: float = None

class RecordPayload(BaseModel):
    notes: str = ""

class LocalizationCapturePayload(BaseModel):
    latitude: float
    longitude: float
    rssi_dbm: Optional[float] = None
    label: str = ""

# ─── Callback from SDRWorker Thread ──────────────────────────────────────────
def on_samples_ready(samples, center_hz, sample_rate_hz, timestamp):
    # Process FFT and detect peaks
    result = signal_processor.process(samples, center_hz, sample_rate_hz, timestamp)
    peaks = signal_processor.detect_peaks(result, signal_processor.threshold_db)
    
    # Write to IQ recorder if active
    if iq_recorder.is_active:
        iq_recorder.write(samples)
        
    # Save detections to Database
    from datetime import datetime
    for peak in peaks:
        # Ignore peaks exactly at center frequency (DC spike)
        if abs(peak.frequency_hz - center_hz) < 1000:
            continue

        detection = Detection(
            id=None,
            frequency_hz=peak.frequency_hz,
            power_dbm=peak.power_dbm,
            bandwidth_hz=peak.bandwidth_hz,
            timestamp=datetime.fromtimestamp(timestamp).isoformat(),
            duration_ms=0.0,
            status="active",
            classification="unknown",
            session_id=_session_id,
            notes="Auto-detected"
        )
        db_manager.save_detection(detection)

    # Process Audio if anyone is listening
    if audio_target_freq_hz is not None and len(audio_queues) > 0 and audio_loop is not None:
        try:
            pcm_bytes = audio_demod.demodulate(samples, sample_rate_hz, audio_target_freq_hz, center_hz, mode=audio_mode)
            if pcm_bytes:
                for q in list(audio_queues):
                    # We keep the queue size small so it doesn't build up massive latency
                    if q.qsize() < 10:
                        audio_loop.call_soon_threadsafe(q.put_nowait, pcm_bytes)
        except Exception as e:
            logger.error(f"Audio demodulation error: {e}")
        
    # Update latest frame for WebSockets
    with frame_lock:
        global latest_frame
        latest_frame = {
            "timestamp": timestamp,
            "center_hz": center_hz,
            "sample_rate_hz": sample_rate_hz,
            "magnitude_db": result.power_dbm,  # Keep as numpy array
            "peaks": [{"freq": p.frequency_hz, "pwr": p.power_dbm} for p in peaks]
        }

def _get_latest_rssi_dbm() -> float:
    with frame_lock:
        frame = latest_frame.copy()
    mags = frame.get("magnitude_db", None)
    if mags is None or len(mags) == 0:
        return -120.0
    return float(np.max(mags))


def _estimate_localization_result() -> Dict[str, Any]:
    if len(localization_points) < 3:
        return {
            "success": False,
            "message": f"Need at least 3 points for RSSI trilateration (have {len(localization_points)}).",
            "latitude": None,
            "longitude": None,
            "confidence_radius_m": None,
            "method": "insufficient_data",
            "n_points": len(localization_points),
        }

    points = [
        MeasPoint(
            lat=p["latitude"],
            lon=p["longitude"],
            rssi_dbm=p["rssi_dbm"],
            label=p.get("label", f"Point {i+1}"),
        )
        for i, p in enumerate(localization_points)
    ]

    model = PathLossModel(reference_power_dbm=-30.0, reference_distance_m=1.0, path_loss_exponent=2.7)
    localizer = RSSILocalizer(model)
    result = localizer.localize(points)

    return {
        "success": result.success,
        "message": "Localization estimate ready." if result.success else "Localization estimate failed.",
        "latitude": result.latitude,
        "longitude": result.longitude,
        "confidence_radius_m": result.confidence_radius_m,
        "method": result.method,
        "residual": result.residual,
        "n_points": result.n_points,
    }

# ─── Application Startup & Shutdown ──────────────────────────────────────────
def _init_and_start_sdr():
    """Initialize the SDR engine and start streaming immediately."""
    global _session_id
    mode = sdr_engine.initialize(auto_fallback=True)
    if sdr_engine.worker:
        sdr_engine.worker.on_samples_ready = on_samples_ready
    # Update session mode to reflect actual hardware state
    if _session_id:
        db_manager.close_session(_session_id)
    _session_id = db_manager.create_session(device_mode=mode.value)
    sdr_engine.start()
    logger.info("SDR started in [%s] mode. Session: %s", mode.value.upper(), _session_id)

@app.on_event("startup")
def startup_event():
    global _session_id, audio_loop
    audio_loop = asyncio.get_event_loop()
    os.makedirs("static", exist_ok=True)

    # Create initial session
    _session_id = db_manager.create_session(device_mode="simulation")

    # Set default configuration before init
    cfg = SDRConfig()
    cfg.center_frequency_hz = 100e6
    cfg.sample_rate_hz = 2e6
    sdr_engine._config = cfg

    # Initialize and auto-start
    _init_and_start_sdr()
    logger.info("Web-SDR Application Started. Session: %s", _session_id)

@app.on_event("shutdown")
def shutdown_event():
    logger.info("Shutting down Web-SDR Application...")
    sdr_engine.stop()
    if iq_recorder.is_active:
        iq_recorder.stop()
    if _session_id:
        db_manager.close_session(_session_id)

# ─── Static Files and Web Interface ──────────────────────────────────────────
if not os.path.exists("static"):
    os.makedirs("static")
    
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def index():
    return FileResponse(os.path.join("static", "index.html"))

# ─── REST API ────────────────────────────────────────────────────────────────
# ─── Signal Classification API ────────────────────────────────────────────────
from enum import Enum

class SignalType(str, Enum):
    FM_BROADCAST = "FM Broadcast"
    AM_BROADCAST = "AM Broadcast"
    SHORTWAVE = "Shortwave"
    CB = "CB Radio"
    HAM_HF = "Ham Radio (HF)"
    HAM_VHF = "Ham Radio (VHF)"
    HAM_UHF = "Ham Radio (UHF)"
    MARINE_VHF = "Marine VHF"
    AIRBAND = "Airband"
    PUBLIC_SAFETY = "Public Safety"
    GSM = "GSM"
    LTE = "LTE/4G"
    GPS = "GPS"
    WIFI = "WiFi"
    BLUETOOTH = "Bluetooth"
    TV_VHF = "VHF TV"
    TV_UHF = "UHF TV"
    SATELLITE = "Satellite"
    RADAR = "Radar"
    UNKNOWN = "Unknown"

SIGNAL_CLASSIFICATIONS = [
    {"type": SignalType.AM_BROADCAST, "min_mhz": 0.53, "max_mhz": 1.70, "modulation": "AM", "bandwidth_khz": 10},
    {"type": SignalType.SHORTWAVE, "min_mhz": 3.00, "max_mhz": 30.00, "modulation": "AM/SSB", "bandwidth_khz": 10},
    {"type": SignalType.CB, "min_mhz": 26.965, "max_mhz": 27.405, "modulation": "AM", "bandwidth_khz": 10},
    {"type": SignalType.HAM_HF, "min_mhz": 3.00, "max_mhz": 30.00, "modulation": "Various", "bandwidth_khz": 20},
    {"type": SignalType.FM_BROADCAST, "min_mhz": 87.50, "max_mhz": 108.00, "modulation": "FM", "bandwidth_khz": 200},
    {"type": SignalType.AIRBAND, "min_mhz": 118.00, "max_mhz": 137.00, "modulation": "AM", "bandwidth_khz": 25},
    {"type": SignalType.MARINE_VHF, "min_mhz": 156.00, "max_mhz": 162.00, "modulation": "FM", "bandwidth_khz": 25},
    {"type": SignalType.HAM_VHF, "min_mhz": 144.00, "max_mhz": 148.00, "modulation": "Various", "bandwidth_khz": 20},
    {"type": SignalType.HAM_UHF, "min_mhz": 430.00, "max_mhz": 440.00, "modulation": "Various", "bandwidth_khz": 20},
    {"type": SignalType.TV_VHF, "min_mhz": 54.00, "max_mhz": 216.00, "modulation": "Analog/Digital", "bandwidth_khz": 6000},
    {"type": SignalType.PUBLIC_SAFETY, "min_mhz": 150.00, "max_mhz": 174.00, "modulation": "P25/FM", "bandwidth_khz": 12.5},
    {"type": SignalType.GSM, "min_mhz": 880.00, "max_mhz": 960.00, "modulation": "GMSK", "bandwidth_khz": 200},
    {"type": SignalType.GSM, "min_mhz": 1710.00, "max_mhz": 1880.00, "modulation": "GMSK", "bandwidth_khz": 200},
    {"type": SignalType.LTE, "min_mhz": 791.00, "max_mhz": 862.00, "modulation": "OFDM", "bandwidth_khz": 10000},
    {"type": SignalType.LTE, "min_mhz": 925.00, "max_mhz": 960.00, "modulation": "OFDM", "bandwidth_khz": 10000},
    {"type": SignalType.LTE, "min_mhz": 2110.00, "max_mhz": 2170.00, "modulation": "OFDM", "bandwidth_khz": 10000},
    {"type": SignalType.WIFI, "min_mhz": 2412.00, "max_mhz": 2495.00, "modulation": "OFDM", "bandwidth_khz": 20000},
    {"type": SignalType.WIFI, "min_mhz": 5170.00, "max_mhz": 5825.00, "modulation": "OFDM", "bandwidth_khz": 20000},
    {"type": SignalType.BLUETOOTH, "min_mhz": 2402.00, "max_mhz": 2480.00, "modulation": "FHSS", "bandwidth_khz": 1000},
    {"type": SignalType.GPS, "min_mhz": 1575.42, "max_mhz": 1575.42, "modulation": "BPSK", "bandwidth_khz": 2046},
    {"type": SignalType.SATELLITE, "min_mhz": 137.00, "max_mhz": 138.00, "modulation": "Various", "bandwidth_khz": 100},
    {"type": SignalType.SATELLITE, "min_mhz": 400.00, "max_mhz": 401.00, "modulation": "Various", "bandwidth_khz": 100},
    {"type": SignalType.RADAR, "min_mhz": 2700.00, "max_mhz": 3000.00, "modulation": "Pulse/Modulated", "bandwidth_khz": 1000},
    {"type": SignalType.TV_UHF, "min_mhz": 470.00, "max_mhz": 698.00, "modulation": "Digital", "bandwidth_khz": 6000},
]

class ClassifyPayload(BaseModel):
    frequency_hz: float

@app.get("/api/classify")
def classify_signal(frequency_hz: float):
    """Classify a signal type based on its center frequency."""
    freq_mhz = frequency_hz / 1e6
    best_match = None
    for entry in SIGNAL_CLASSIFICATIONS:
        if entry["min_mhz"] <= freq_mhz <= entry["max_mhz"]:
            best_match = entry
            break
    if best_match:
        return {
            "frequency_hz": frequency_hz,
            "signal_type": best_match["type"],
            "modulation": best_match["modulation"],
            "typical_bandwidth_khz": best_match["bandwidth_khz"],
            "confidence": "high"
        }
    return {
        "frequency_hz": frequency_hz,
        "signal_type": SignalType.UNKNOWN,
        "modulation": "N/A",
        "typical_bandwidth_khz": None,
        "confidence": "low"
    }

@app.get("/api/status")
def get_status():
    cfg = sdr_engine._config
    worker = sdr_engine.worker
    is_running = bool(worker and worker.is_alive() and worker._running)
    return {
        "mode": sdr_engine.mode.value,
        "running": is_running,
        "config": {
            "center_frequency_hz": cfg.center_frequency_hz,
            "sample_rate_hz": cfg.sample_rate_hz,
            "lna_gain": cfg.lna_gain,
            "vga_gain": cfg.vga_gain,
            "amp_enabled": cfg.amp_enabled,
            "scan_mode": cfg.scan_mode.value,
            "sweep_start_hz": cfg.sweep_start_hz,
            "sweep_stop_hz": cfg.sweep_stop_hz,
            "sweep_step_hz": cfg.sweep_step_hz,
            "dwell_time_ms": cfg.dwell_time_ms,
            "threshold_db": signal_processor.threshold_db,
            "min_snr_db": signal_processor.min_snr_db
        },
        "recording": {
            "active": iq_recorder.is_active,
            "bytes_written": iq_recorder.bytes_written,
            "elapsed_sec": iq_recorder.elapsed_sec
        }
    }

@app.post("/api/config")
def update_config(payload: ConfigPayload):
    cfg = sdr_engine._config
    
    if payload.center_frequency_hz is not None:
        cfg.center_frequency_hz = payload.center_frequency_hz
    if payload.sample_rate_hz is not None:
        cfg.sample_rate_hz = payload.sample_rate_hz
    if payload.lna_gain is not None:
        cfg.lna_gain = payload.lna_gain
    if payload.vga_gain is not None:
        cfg.vga_gain = payload.vga_gain
    if payload.amp_enabled is not None:
        cfg.amp_enabled = payload.amp_enabled
    if payload.scan_mode is not None:
        cfg.scan_mode = ScanMode(payload.scan_mode)
    if payload.sweep_start_hz is not None:
        cfg.sweep_start_hz = payload.sweep_start_hz
    if payload.sweep_stop_hz is not None:
        cfg.sweep_stop_hz = payload.sweep_stop_hz
    if payload.sweep_step_hz is not None:
        cfg.sweep_step_hz = payload.sweep_step_hz
    if payload.dwell_time_ms is not None:
        cfg.dwell_time_ms = payload.dwell_time_ms
        
    sdr_engine.set_config(cfg)
    
    if payload.threshold_db is not None:
        signal_processor.threshold_db = payload.threshold_db
    if payload.min_snr_db is not None:
        signal_processor.min_snr_db = payload.min_snr_db
        
    return get_status()

@app.post("/api/start")
def start_sdr():
    worker = sdr_engine.worker
    if worker and worker.is_alive():
        return {"status": "already running"}
    # Re-initialize to get a fresh worker thread (threads can only be started once)
    _init_and_start_sdr()
    return get_status()

@app.post("/api/stop")
def stop_sdr():
    sdr_engine.stop()
    return get_status()


@app.post("/api/reload")
def reload_hardware(auto_fallback: bool = True):
    """Stop current worker, re-initialize the SDR engine (attempt hardware), and start.

    Useful to call from the web UI after plugging in hardware without restarting the server.
    """
    global _session_id
    try:
        # Stop current worker if running
        sdr_engine.stop()

        # Close previous session (if any)
        if _session_id:
            try:
                db_manager.close_session(_session_id)
            except Exception:
                pass

        # Re-initialize engine; this will attempt hardware and fall back if allowed
        mode = sdr_engine.initialize(auto_fallback=auto_fallback)
        if sdr_engine.worker:
            sdr_engine.worker.on_samples_ready = on_samples_ready

        # Create a fresh session record
        _session_id = db_manager.create_session(device_mode=mode.value)

        # Start streaming
        sdr_engine.start()
        logger.info("Hardware reload requested; engine now in %s mode.", mode.value)
        return get_status()
    except Exception as e:
        logger.exception("Failed to reload hardware: %s", e)
        return {"error": str(e)}

@app.post("/api/record/start")
def start_recording(payload: RecordPayload):
    if not sdr_engine.worker or not sdr_engine.worker._running:
        return {"error": "SDR is not running"}
    try:
        path = iq_recorder.start(
            center_freq_hz=sdr_engine._config.center_frequency_hz,
            sample_rate_hz=sdr_engine._config.sample_rate_hz,
            notes=payload.notes
        )
        return {"status": "recording started", "path": path}
    except Exception as e:
        return {"error": str(e)}

@app.post("/api/record/stop")
def stop_recording():
    meta = iq_recorder.stop()
    return {"status": "recording stopped", "metadata": meta.to_dict() if meta else None}

@app.get("/api/detections")
def get_recent_detections(limit: int = 50):
    detections = db_manager.get_detections(limit=limit)
    return [
        {
            "id": d.id,
            "timestamp": d.timestamp,
            "frequency_hz": d.frequency_hz,
            "power_dbm": d.power_dbm,
            "bandwidth_hz": d.bandwidth_hz,
            "confidence": 0.9,
            "notes": d.notes,
            "latitude": None,
            "longitude": None
        }
        for d in detections
    ]


# ─── Localization API ─────────────────────────────────────────────────────────
@app.post("/api/localization/capture")
def capture_localization_point(payload: LocalizationCapturePayload):
    """Capture a measurement point for RSSI-based localization."""
    rssi = payload.rssi_dbm if payload.rssi_dbm is not None else _get_latest_rssi_dbm()
    label = payload.label or f"Point {len(localization_points) + 1}"
    point = {
        "latitude": payload.latitude,
        "longitude": payload.longitude,
        "rssi_dbm": rssi,
        "label": label,
    }
    localization_points.append(point)
    logger.info("Localization point captured: %s (RSSI=%.1f dBm)", label, rssi)
    estimate = _estimate_localization_result() if len(localization_points) >= 3 else None
    return {"count": len(localization_points), "point": point, "estimate": estimate}

@app.post("/api/localization/reset")
def reset_localization_points():
    """Clear all captured localization points."""
    localization_points.clear()
    logger.info("Localization points reset.")
    return {"count": 0}

@app.get("/api/localization/estimate")
def get_localization_estimate():
    """Get the current RSSI trilateration estimate from captured points."""
    return _estimate_localization_result()

def pack_spectrum_frame(frame: dict) -> bytes:
    """Pack spectrum frame into binary format.
    Header: timestamp (d), center_hz (d), sample_rate_hz (d), num_peaks (I), num_mags (I) (32 bytes)
    Peaks: num_peaks * (freq: d, pwr: d) (num_peaks * 16 bytes)
    Magnitudes: num_mags * float32 (num_mags * 4 bytes)
    """
    ts = float(frame.get("timestamp", 0.0))
    center = float(frame.get("center_hz", 0.0))
    sr = float(frame.get("sample_rate_hz", 0.0))
    peaks = frame.get("peaks", [])
    mags = frame.get("magnitude_db", None)
    
    if mags is None:
        mags = np.array([], dtype=np.float32)
    else:
        mags = np.asarray(mags, dtype=np.float32)
        
    num_peaks = len(peaks)
    num_mags = len(mags)
    
    header = struct.pack('<dddII', ts, center, sr, num_peaks, num_mags)
    
    peaks_bytes = bytearray()
    for p in peaks:
        peaks_bytes.extend(struct.pack('<dd', float(p.get("freq", 0.0)), float(p.get("pwr", 0.0))))
        
    return bytes(header) + bytes(peaks_bytes) + mags.tobytes()

# ─── WebSocket ───────────────────────────────────────────────────────────────
@app.websocket("/ws/spectrum")
async def ws_spectrum(websocket: WebSocket):
    await websocket.accept()
    last_sent_ts = 0.0
    try:
        while True:
            # Throttle the send rate to the client
            await asyncio.sleep(0.05) # max 20 fps
            
            with frame_lock:
                frame = latest_frame.copy()
                
            if not frame:
                continue
                
            ts = frame.get("timestamp", 0)
            if ts != last_sent_ts:
                binary_data = pack_spectrum_frame(frame)
                await websocket.send_bytes(binary_data)
                last_sent_ts = ts
                
    except WebSocketDisconnect:
        logger.info("Client disconnected from WebSocket.")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        await websocket.close()

@app.websocket("/ws/audio")
async def ws_audio(websocket: WebSocket):
    global audio_target_freq_hz, audio_mode
    await websocket.accept()
    logger.info("Audio WebSocket client connected.")
    
    q = asyncio.Queue()
    audio_queues.append(q)
    
    # Task to consume from the queue and send to the client
    async def send_audio():
        try:
            while True:
                data = await q.get()
                await websocket.send_bytes(data)
        except Exception as e:
            logger.error(f"Audio send task error: {e}")

    send_task = asyncio.create_task(send_audio())
    
    try:
        while True:
            msg = await websocket.receive_json()
            action = msg.get("action")
            if action == "start":
                audio_target_freq_hz = float(msg.get("freq_hz", 99e6))
                audio_mode = msg.get("mode", "FM")
                logger.info(f"Audio streaming started for {audio_target_freq_hz / 1e6} MHz in {audio_mode} mode")
            elif action == "stop":
                # Only stop if it's the current target (in a real multi-user setup we'd be more careful)
                audio_target_freq_hz = None
                logger.info("Audio streaming stopped.")
    except WebSocketDisconnect:
        logger.info("Audio WebSocket client disconnected.")
    except Exception as e:
        logger.error(f"Audio WebSocket receive error: {e}")
    finally:
        send_task.cancel()
        if q in audio_queues:
            audio_queues.remove(q)
        # If no more listeners, stop demodulating
        if len(audio_queues) == 0:
            audio_target_freq_hz = None
