"""
utils/logger.py
Application-wide logging configuration.
"""

import logging
import logging.handlers
import os
import sys
from datetime import datetime


def setup_logger(name: str = "sdr_monitor",
                 log_level: str = "INFO",
                 log_dir: str = "logs") -> logging.Logger:
    """
    Configure and return the root application logger.

    Args:
        name:      Logger name.
        log_level: Logging level string (DEBUG, INFO, WARNING, ERROR).
        log_dir:   Directory where log files will be stored.

    Returns:
        Configured Logger instance.
    """
    os.makedirs(log_dir, exist_ok=True)

    level = getattr(logging, log_level.upper(), logging.INFO)

    logger = logging.getLogger(name)
    logger.setLevel(level)

    # Avoid adding duplicate handlers on re-import
    if logger.handlers:
        return logger

    # ── Console handler ────────────────────────────────────────────────────────
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)
    console_fmt = logging.Formatter(
        fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    console_handler.setFormatter(console_fmt)
    logger.addHandler(console_handler)

    # ── Rotating file handler ─────────────────────────────────────────────────
    timestamp = datetime.now().strftime("%Y%m%d")
    log_file = os.path.join(log_dir, f"sdr_monitor_{timestamp}.log")
    file_handler = logging.handlers.RotatingFileHandler(
        log_file,
        maxBytes=10 * 1024 * 1024,   # 10 MB
        backupCount=5,
        encoding="utf-8",
    )
    file_handler.setLevel(logging.DEBUG)
    file_fmt = logging.Formatter(
        fmt="%(asctime)s [%(levelname)-8s] %(name)s (%(filename)s:%(lineno)d): %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    file_handler.setFormatter(file_fmt)
    logger.addHandler(file_handler)

    logger.info("Logger initialized  →  %s", log_file)
    return logger


def get_logger(module_name: str) -> logging.Logger:
    """Return a child logger for the given module name."""
    return logging.getLogger(f"sdr_monitor.{module_name}")
