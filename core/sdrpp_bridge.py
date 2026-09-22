"""
Bridge between SDR++ Network Output (UDP PCM) and the existing audio WebSocket.
Replaces Python-based audio_demodulator.demodulate() for audio streaming.
Spectrum/RSSI/triangulation remain Python-based.
"""
import asyncio
import socket
import threading
import time
import logging
from typing import List, Optional

logger = logging.getLogger("sdrpp_bridge")

class SDRPPAudioBridge:
    def __init__(self, host: str = "127.0.0.1", port: int = 7355, 
                 audio_queues: List[asyncio.Queue] = None,
                 audio_loop: Optional[asyncio.AbstractEventLoop] = None):
        self.host = host
        self.port = port
        self.audio_queues = audio_queues or []
        self.audio_loop = audio_loop
        self._running = False
        self._sock: Optional[socket.socket] = None
        self._thread: Optional[threading.Thread] = None
        self._last_packet_time = 0.0
        self._packet_count = 0
    
    def start(self):
        if self._running:
            return
        self._running = True
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.settimeout(1.0)
        self._sock.bind((self.host, self.port))
        self._thread = threading.Thread(target=self._receive_loop, daemon=True)
        self._thread.start()
        logger.info(f"SDR++ bridge listening on UDP {self.host}:{self.port}")
    
    def stop(self):
        self._running = False
        if self._sock:
            self._sock.close()
        if self._thread:
            self._thread.join(timeout=2.0)
        logger.info("SDR++ bridge stopped")
    
    def _receive_loop(self):
        while self._running:
            try:
                data, addr = self._sock.recvfrom(8192)
                self._last_packet_time = time.time()
                self._packet_count += 1
                # Forward raw PCM to all audio queues
                for q in list(self.audio_queues):
                    if q.qsize() < 30 and self.audio_loop is not None:
                        try:
                            self.audio_loop.call_soon_threadsafe(q.put_nowait, data)
                        except Exception as e:
                            logger.warning(f"Queue put failed: {e}")
            except socket.timeout:
                continue
            except Exception as e:
                if self._running:
                    logger.error(f"Bridge receive error: {e}")
                    break
    def is_receiving(self) -> bool:
        """Return True if SDR++ has sent audio packets recently (within 2 seconds)."""
        import time as _time
        return self._running and (_time.time() - self._last_packet_time) < 2.0
    