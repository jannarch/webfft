"""
core/cpp_dsp_wrapper.py
Python ctypes interface for native C++ DSP acceleration library (cpp_dsp.dll).
Includes automatic fallback to vectorized NumPy routines if native library is unavailable.
"""

import os
import ctypes
import numpy as np
from typing import Optional, Tuple
from utils.logger import get_logger

logger = get_logger("cpp_dsp")

# Path to compiled shared library
_DIR = os.path.dirname(os.path.abspath(__file__))
_DLL_NAME = "cpp_dsp.dll" if os.name == "nt" else "cpp_dsp.so"
_DLL_PATH = os.path.join(_DIR, _DLL_NAME)

_lib = None
try:
    if os.path.exists(_DLL_PATH):
        _lib = ctypes.CDLL(_DLL_PATH)
        logger.info(f"Loaded native C++ DSP library from {_DLL_PATH}")
    else:
        logger.warning(f"Native DSP library not found at {_DLL_PATH}; using NumPy fallback.")
except Exception as e:
    logger.error(f"Failed to load native DSP library: {e}; using NumPy fallback.")
    _lib = None

# Configure ctypes signatures if DLL loaded
if _lib is not None:
    # 1. dsp_shift_and_decimate
    _lib.dsp_shift_and_decimate.argtypes = [
        ctypes.POINTER(ctypes.c_float),   # in_iq
        ctypes.c_int,                     # n_in
        ctypes.c_float,                   # sample_rate
        ctypes.c_float,                   # offset_hz
        ctypes.POINTER(ctypes.c_double),  # phase_inout
        ctypes.c_int,                     # decimation_factor
        ctypes.POINTER(ctypes.c_float),   # out_iq
    ]
    _lib.dsp_shift_and_decimate.restype = ctypes.c_int

    # 2. dsp_demod_fm
    _lib.dsp_demod_fm.argtypes = [
        ctypes.POINTER(ctypes.c_float),  # in_iq
        ctypes.c_int,                    # n_samples
        ctypes.c_float,                  # scale_factor
        ctypes.POINTER(ctypes.c_float),  # last_i
        ctypes.POINTER(ctypes.c_float),  # last_q
        ctypes.POINTER(ctypes.c_float),  # out_audio
    ]
    _lib.dsp_demod_fm.restype = ctypes.c_int

    # 3. dsp_demod_am
    _lib.dsp_demod_am.argtypes = [
        ctypes.POINTER(ctypes.c_float),  # in_iq
        ctypes.c_int,                    # n_samples
        ctypes.c_float,                  # scale_factor
        ctypes.POINTER(ctypes.c_float),  # out_audio
    ]
    _lib.dsp_demod_am.restype = ctypes.c_int

    # 4. dsp_dc_block
    _lib.dsp_dc_block.argtypes = [
        ctypes.POINTER(ctypes.c_float),  # in_audio
        ctypes.c_int,                    # n_samples
        ctypes.c_float,                  # alpha
        ctypes.POINTER(ctypes.c_float),  # prev_x
        ctypes.POINTER(ctypes.c_float),  # prev_y
        ctypes.POINTER(ctypes.c_float),  # out_audio
    ]
    _lib.dsp_dc_block.restype = ctypes.c_int

    # 5. dsp_fir_filter
    _lib.dsp_fir_filter.argtypes = [
        ctypes.POINTER(ctypes.c_float),  # in_audio
        ctypes.c_int,                    # n_samples
        ctypes.POINTER(ctypes.c_float),  # taps
        ctypes.c_int,                    # num_taps
        ctypes.POINTER(ctypes.c_float),  # state_history
        ctypes.POINTER(ctypes.c_float),  # out_audio
    ]
    _lib.dsp_fir_filter.restype = ctypes.c_int

    # 6. dsp_deemphasis
    _lib.dsp_deemphasis.argtypes = [
        ctypes.POINTER(ctypes.c_float),  # in_audio
        ctypes.c_int,                    # n_samples
        ctypes.c_float,                  # alpha
        ctypes.POINTER(ctypes.c_float),  # prev_y
        ctypes.POINTER(ctypes.c_float),  # out_audio
    ]
    _lib.dsp_deemphasis.restype = ctypes.c_int

    # 7. dsp_resample_linear
    _lib.dsp_resample_linear.argtypes = [
        ctypes.POINTER(ctypes.c_float),  # in_audio
        ctypes.c_int,                    # in_len
        ctypes.POINTER(ctypes.c_float),  # out_audio
        ctypes.c_int,                    # out_len
    ]
    _lib.dsp_resample_linear.restype = ctypes.c_int

    # 8. dsp_float_to_int16
    _lib.dsp_float_to_int16.argtypes = [
        ctypes.POINTER(ctypes.c_float),  # in_audio
        ctypes.c_int,                    # n_samples
        ctypes.c_float,                  # gain
        ctypes.POINTER(ctypes.c_int16),  # out_pcm
    ]
    _lib.dsp_float_to_int16.restype = ctypes.c_int


class CppDSP:
    """Python interface providing native C++ accelerated DSP functions."""

    def __init__(self):
        self.is_native_available = (_lib is not None)

    def shift_and_decimate(
        self,
        samples: np.ndarray,
        sample_rate_hz: float,
        offset_hz: float,
        phase: float,
        decimation_factor: int,
    ) -> Tuple[np.ndarray, float]:
        """
        NCO frequency-shifts by offset_hz and decimates complex IQ samples.
        Returns (baseband_complex64, updated_phase).
        """
        n_in = len(samples)
        if n_in == 0 or decimation_factor <= 0:
            return np.empty(0, dtype=np.complex64), phase

        n_out = n_in // decimation_factor
        if n_out == 0:
            return np.empty(0, dtype=np.complex64), phase

        if self.is_native_available:
            c_samples = np.ascontiguousarray(samples, dtype=np.complex64)
            in_ptr = c_samples.ctypes.data_as(ctypes.POINTER(ctypes.c_float))

            out_bb = np.empty(n_out, dtype=np.complex64)
            out_ptr = out_bb.ctypes.data_as(ctypes.POINTER(ctypes.c_float))

            phase_val = ctypes.c_double(phase)

            _lib.dsp_shift_and_decimate(
                in_ptr,
                n_in,
                ctypes.c_float(sample_rate_hz),
                ctypes.c_float(offset_hz),
                ctypes.byref(phase_val),
                ctypes.c_int(decimation_factor),
                out_ptr,
            )
            return out_bb, float(phase_val.value)
        else:
            # Fallback
            t = np.arange(n_in, dtype=np.float32) / sample_rate_hz
            phase_vec = phase + 2.0 * np.pi * offset_hz * t
            shifted = (samples * np.exp(1j * phase_vec)).astype(np.complex64)
            new_phase = (phase + 2.0 * np.pi * offset_hz * (n_in / sample_rate_hz)) % (2.0 * np.pi)

            if decimation_factor > 1:
                trim = n_out * decimation_factor
                baseband = shifted[:trim].reshape(-1, decimation_factor).mean(axis=1)
            else:
                baseband = shifted
            return baseband, new_phase

    def demod_fm(
        self,
        baseband: np.ndarray,
        scale_factor: float,
        last_i: float,
        last_q: float,
    ) -> Tuple[np.ndarray, float, float]:
        """
        Delay-multiply FM demodulation.
        Returns (demod_audio_float32, new_last_i, new_last_q).
        """
        n_samples = len(baseband)
        if n_samples == 0:
            return np.empty(0, dtype=np.float32), last_i, last_q

        if self.is_native_available:
            c_bb = np.ascontiguousarray(baseband, dtype=np.complex64)
            in_ptr = c_bb.ctypes.data_as(ctypes.POINTER(ctypes.c_float))

            out_audio = np.empty(n_samples, dtype=np.float32)
            out_ptr = out_audio.ctypes.data_as(ctypes.POINTER(ctypes.c_float))

            c_i = ctypes.c_float(last_i)
            c_q = ctypes.c_float(last_q)

            _lib.dsp_demod_fm(
                in_ptr,
                n_samples,
                ctypes.c_float(scale_factor),
                ctypes.byref(c_i),
                ctypes.byref(c_q),
                out_ptr,
            )
            return out_audio, float(c_i.value), float(c_q.value)
        else:
            delayed = np.concatenate(([complex(last_i, last_q)], baseband[:-1]))
            diff = baseband * np.conj(delayed)
            out_audio = (np.angle(diff) * scale_factor).astype(np.float32)
            return out_audio, float(baseband[-1].real), float(baseband[-1].imag)

    def demod_am(
        self,
        baseband: np.ndarray,
        scale_factor: float = 1.0,
    ) -> np.ndarray:
        """
        Envelope AM demodulation (sqrt(I^2 + Q^2)).
        """
        n_samples = len(baseband)
        if n_samples == 0:
            return np.empty(0, dtype=np.float32)

        if self.is_native_available:
            c_bb = np.ascontiguousarray(baseband, dtype=np.complex64)
            in_ptr = c_bb.ctypes.data_as(ctypes.POINTER(ctypes.c_float))

            out_audio = np.empty(n_samples, dtype=np.float32)
            out_ptr = out_audio.ctypes.data_as(ctypes.POINTER(ctypes.c_float))

            _lib.dsp_demod_am(
                in_ptr,
                n_samples,
                ctypes.c_float(scale_factor),
                out_ptr,
            )
            return out_audio
        else:
            return (np.abs(baseband) * scale_factor).astype(np.float32)

    def dc_block(
        self,
        audio: np.ndarray,
        alpha: float,
        prev_x: float,
        prev_y: float,
    ) -> Tuple[np.ndarray, float, float]:
        """
        Single-pole DC-blocker.
        Returns (out_audio, new_prev_x, new_prev_y).
        """
        n = len(audio)
        if n == 0:
            return np.empty(0, dtype=np.float32), prev_x, prev_y

        if self.is_native_available:
            c_in = np.ascontiguousarray(audio, dtype=np.float32)
            in_ptr = c_in.ctypes.data_as(ctypes.POINTER(ctypes.c_float))

            out = np.empty(n, dtype=np.float32)
            out_ptr = out.ctypes.data_as(ctypes.POINTER(ctypes.c_float))

            c_px = ctypes.c_float(prev_x)
            c_py = ctypes.c_float(prev_y)

            _lib.dsp_dc_block(
                in_ptr,
                n,
                ctypes.c_float(alpha),
                ctypes.byref(c_px),
                ctypes.byref(c_py),
                out_ptr,
            )
            return out, float(c_px.value), float(c_py.value)
        else:
            out = np.empty(n, dtype=np.float32)
            px = prev_x
            py = prev_y
            for i in range(n):
                x = audio[i]
                y = x - px + alpha * py
                out[i] = y
                px = x
                py = y
            return out, px, py

    def deemphasis(
        self,
        audio: np.ndarray,
        alpha: float,
        prev_y: float,
    ) -> Tuple[np.ndarray, float]:
        """
        Single-pole de-emphasis filter.
        Returns (out_audio, new_prev_y).
        """
        n = len(audio)
        if n == 0:
            return np.empty(0, dtype=np.float32), prev_y

        if self.is_native_available:
            c_in = np.ascontiguousarray(audio, dtype=np.float32)
            in_ptr = c_in.ctypes.data_as(ctypes.POINTER(ctypes.c_float))

            out = np.empty(n, dtype=np.float32)
            out_ptr = out.ctypes.data_as(ctypes.POINTER(ctypes.c_float))

            c_py = ctypes.c_float(prev_y)

            _lib.dsp_deemphasis(
                in_ptr,
                n,
                ctypes.c_float(alpha),
                ctypes.byref(c_py),
                out_ptr,
            )
            return out, float(c_py.value)
        else:
            out = np.empty(n, dtype=np.float32)
            py = prev_y
            one_m_alpha = 1.0 - alpha
            for i in range(n):
                py = one_m_alpha * audio[i] + alpha * py
                out[i] = py
            return out, py

    def resample_linear(
        self,
        audio: np.ndarray,
        n_out: int,
    ) -> np.ndarray:
        """
        Linear resampling from len(audio) to n_out samples.
        """
        n_in = len(audio)
        if n_in < 2 or n_out <= 0:
            return np.empty(0, dtype=np.float32)

        if self.is_native_available:
            c_in = np.ascontiguousarray(audio, dtype=np.float32)
            in_ptr = c_in.ctypes.data_as(ctypes.POINTER(ctypes.c_float))

            out = np.empty(n_out, dtype=np.float32)
            out_ptr = out.ctypes.data_as(ctypes.POINTER(ctypes.c_float))

            _lib.dsp_resample_linear(
                in_ptr,
                n_in,
                out_ptr,
                n_out,
            )
            return out
        else:
            return np.interp(
                np.linspace(0.0, 1.0, n_out),
                np.linspace(0.0, 1.0, n_in),
                audio,
            ).astype(np.float32)

    def float_to_int16(
        self,
        audio: np.ndarray,
        gain: float = 1.0,
    ) -> np.ndarray:
        """
        Clips audio * gain to [-1.0, 1.0] and converts to int16 PCM.
        """
        n = len(audio)
        if n == 0:
            return np.empty(0, dtype=np.int16)

        if self.is_native_available:
            c_in = np.ascontiguousarray(audio, dtype=np.float32)
            in_ptr = c_in.ctypes.data_as(ctypes.POINTER(ctypes.c_float))

            out = np.empty(n, dtype=np.int16)
            out_ptr = out.ctypes.data_as(ctypes.POINTER(ctypes.c_int16))

            _lib.dsp_float_to_int16(
                in_ptr,
                n,
                ctypes.c_float(gain),
                out_ptr,
            )
            return out
        else:
            return np.int16(np.clip(audio * gain, -1.0, 1.0) * 32767)
