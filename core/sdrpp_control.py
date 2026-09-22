"""
TCP client to control SDR++ via its remote control API.
Syncs frequency, mode, and gain from the web UI to SDR++.
"""
import socket
import threading
import logging
from typing import Optional

import time

logger = logging.getLogger("sdrpp_control")

# SDR++ command format (newline-terminated):
#   "FREQ <hz>"  - set center frequency
#   "MODE <mode>" - set demodulation mode (WFM, NFM, AM, LSB, USB, CW, DSB, RAW)
#   "GAIN <stage> <db>" - set gain
#   "START" / "STOP" - start/stop the radio

class SDRPPControl:
    def __init__(self, host: str = "127.0.0.1", port: int = 5259):
        self.host = host
        self.port = port
        self._sock: Optional[socket.socket] = None
        self._lock = threading.Lock()
        self._connected = False
        self._last_connect_time = 0.0
        self._connect_cooldown = 5.0  # seconds between reconnect attempts if offline
        self._mode_map = {
            "FM": "WFM",
            "AM": "AM",
            "NFM": "NFM",
        }
    
    def _connect(self):
        if self._connected:
            return
        # Throttle connection attempts if SDR++ is offline
        now = time.time()
        if (now - self._last_connect_time) < self._connect_cooldown:
            return
        self._last_connect_time = now

        try:
            self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self._sock.settimeout(0.15)  # Fast 150ms timeout so we never stall the server
            self._sock.connect((self.host, self.port))
            self._sock.settimeout(1.0)
            self._connected = True
            logger.info(f"SDR++ control connected to {self.host}:{self.port}")
        except Exception as e:
            logger.debug(f"SDR++ control connect failed (SDR++ likely not running): {e}")
            self._connected = False
            if self._sock:
                try:
                    self._sock.close()
                except Exception:
                    pass
                self._sock = None
    
    def _send(self, cmd: str):
        with self._lock:
            if not self._connected:
                self._connect()
            if not self._connected or not self._sock:
                return False
            try:
                self._sock.sendall((cmd + "\n").encode("utf-8"))
                return True
            except Exception as e:
                logger.debug(f"SDR++ send failed: {e}")
                self._connected = False
                try:
                    self._sock.close()
                except Exception:
                    pass
                self._sock = None
                return False
    
    def set_frequency(self, freq_hz: float) -> bool:
        return self._send(f"FREQ {int(freq_hz)}")
    
    def set_mode(self, web_mode: str) -> bool:
        """Translate web mode (FM/AM) to SDR++ mode (WFM/AM/NFM)."""
        sdrpp_mode = self._mode_map.get(web_mode.upper(), "WFM")
        return self._send(f"MODE {sdrpp_mode}")
    
    def start(self) -> bool:
        return self._send("START")
    
    def stop(self) -> bool:
        return self._send("STOP")
    
    def is_connected(self) -> bool:
        return self._connected
    
    def close(self):
        with self._lock:
            if self._sock:
                try:
                    self._sock.close()
                except Exception:
                    pass
                self._sock = None
            self._connected = False