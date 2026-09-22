/**
 * core/cpp_dsp.cpp
 * High-performance C++ DSP routines for Web-SDR audio demodulation.
 * Compiled with MinGW-W64 GCC / MSVC as a native shared library (.dll).
 */

#include <cmath>
#include <cstdint>
#include <cstring>
#include <algorithm>

#if defined(_WIN32) || defined(__CYGWIN__)
  #define DSP_EXPORT extern "C" __declspec(dllexport)
#else
  #define DSP_EXPORT extern "C" __attribute__((visibility("default")))
#endif

#ifndef M_PI
  #define M_PI 3.14159265358979323846
#endif

/**
 * 1. Frequency shift and decimate in a single pass.
 * Input: in_iq (interleaved float: I0, Q0, I1, Q1, ..., length 2 * n_in)
 * Output: out_iq (interleaved float: length 2 * (n_in / decimation_factor))
 * Updates *phase_inout.
 */
DSP_EXPORT int dsp_shift_and_decimate(
    const float* in_iq,
    int n_in,
    float sample_rate,
    float offset_hz,
    double* phase_inout,
    int decimation_factor,
    float* out_iq
) {
    if (!in_iq || !out_iq || n_in <= 0 || decimation_factor <= 0) return 0;

    double phase = phase_inout ? *phase_inout : 0.0;
    const double phase_inc = (2.0 * M_PI * (double)offset_hz) / (double)sample_rate;
    const double two_pi = 2.0 * M_PI;

    const int n_out = n_in / decimation_factor;
    const float inv_dec = 1.0f / (float)decimation_factor;

    int in_idx = 0;
    for (int o = 0; o < n_out; ++o) {
        float sum_i = 0.0f;
        float sum_q = 0.0f;

        for (int d = 0; d < decimation_factor; ++d) {
            float i_raw = in_iq[in_idx * 2];
            float q_raw = in_iq[in_idx * 2 + 1];
            in_idx++;

            // Complex multiplication with e^(j * phase):
            // (I + jQ) * (cos(phase) + j sin(phase))
            // Real = I*cos - Q*sin
            // Imag = I*sin + Q*cos
            float cos_val = (float)std::cos(phase);
            float sin_val = (float)std::sin(phase);

            sum_i += (i_raw * cos_val - q_raw * sin_val);
            sum_q += (i_raw * sin_val + q_raw * cos_val);

            phase += phase_inc;
            if (phase > two_pi) phase -= two_pi;
            else if (phase < -two_pi) phase += two_pi;
        }

        out_iq[o * 2]     = sum_i * inv_dec;
        out_iq[o * 2 + 1] = sum_q * inv_dec;
    }

    if (phase_inout) *phase_inout = phase;
    return n_out;
}

/**
 * 2. Delay-multiply FM Demodulation.
 * Computes: angle( s[n] * conj(s[n-1]) ) * scale_factor
 */
DSP_EXPORT int dsp_demod_fm(
    const float* in_iq,
    int n_samples,
    float scale_factor,
    float* last_i,
    float* last_q,
    float* out_audio
) {
    if (!in_iq || !out_audio || n_samples <= 0) return 0;

    float prev_i = last_i ? *last_i : 0.0f;
    float prev_q = last_q ? *last_q : 0.0f;

    for (int n = 0; n < n_samples; ++n) {
        float cur_i = in_iq[n * 2];
        float cur_q = in_iq[n * 2 + 1];

        // s[n] * conj(s[n-1]) = (cur_i + j*cur_q) * (prev_i - j*prev_q)
        // real = cur_i * prev_i + cur_q * prev_q
        // imag = cur_q * prev_i - cur_i * prev_q
        float real_part = cur_i * prev_i + cur_q * prev_q;
        float imag_part = cur_q * prev_i - cur_i * prev_q;

        float angle = std::atan2(imag_part, real_part);
        out_audio[n] = angle * scale_factor;

        prev_i = cur_i;
        prev_q = cur_q;
    }

    if (last_i) *last_i = prev_i;
    if (last_q) *last_q = prev_q;
    return n_samples;
}

/**
 * 3. Envelope AM Demodulation.
 * Computes: sqrt(I^2 + Q^2) * scale_factor
 */
DSP_EXPORT int dsp_demod_am(
    const float* in_iq,
    int n_samples,
    float scale_factor,
    float* out_audio
) {
    if (!in_iq || !out_audio || n_samples <= 0) return 0;

    for (int n = 0; n < n_samples; ++n) {
        float cur_i = in_iq[n * 2];
        float cur_q = in_iq[n * 2 + 1];
        out_audio[n] = std::sqrt(cur_i * cur_i + cur_q * cur_q) * scale_factor;
    }
    return n_samples;
}

/**
 * 4. DC-Blocker Filter:
 * y[n] = x[n] - x[n-1] + alpha * y[n-1]
 */
DSP_EXPORT int dsp_dc_block(
    const float* in_audio,
    int n_samples,
    float alpha,
    float* prev_x,
    float* prev_y,
    float* out_audio
) {
    if (!in_audio || !out_audio || n_samples <= 0) return 0;

    float px = prev_x ? *prev_x : 0.0f;
    float py = prev_y ? *prev_y : 0.0f;

    for (int n = 0; n < n_samples; ++n) {
        float x = in_audio[n];
        float y = x - px + alpha * py;
        out_audio[n] = y;
        px = x;
        py = y;
    }

    if (prev_x) *prev_x = px;
    if (prev_y) *prev_y = py;
    return n_samples;
}

/**
 * 5. FIR Filter with state buffer.
 * Performs direct convolution with symmetric/arbitrary FIR coefficients.
 * state_history must hold at least (num_taps - 1) floats.
 */
DSP_EXPORT int dsp_fir_filter(
    const float* in_audio,
    int n_samples,
    const float* taps,
    int num_taps,
    float* state_history,
    float* out_audio
) {
    if (!in_audio || !out_audio || !taps || n_samples <= 0 || num_taps <= 0) return 0;

    const int hist_len = num_taps - 1;

    for (int n = 0; n < n_samples; ++n) {
        float acc = in_audio[n] * taps[0];

        for (int k = 1; k < num_taps; ++k) {
            float sample_val;
            if (n - k >= 0) {
                sample_val = in_audio[n - k];
            } else if (state_history) {
                // Read from history: index hist_len + (n - k)
                sample_val = state_history[hist_len + (n - k)];
            } else {
                sample_val = 0.0f;
            }
            acc += sample_val * taps[k];
        }

        out_audio[n] = acc;
    }

    // Save tail to state history
    if (state_history && hist_len > 0) {
        if (n_samples >= hist_len) {
            std::memcpy(state_history, &in_audio[n_samples - hist_len], hist_len * sizeof(float));
        } else {
            // Shift remaining old history left and append new samples
            int keep = hist_len - n_samples;
            std::memmove(state_history, &state_history[n_samples], keep * sizeof(float));
            std::memcpy(&state_history[keep], in_audio, n_samples * sizeof(float));
        }
    }

    return n_samples;
}

/**
 * 6. De-emphasis filter:
 * Single-pole IIR: y[n] = (1 - alpha) * x[n] + alpha * y[n-1]
 */
DSP_EXPORT int dsp_deemphasis(
    const float* in_audio,
    int n_samples,
    float alpha,
    float* prev_y,
    float* out_audio
) {
    if (!in_audio || !out_audio || n_samples <= 0) return 0;

    float py = prev_y ? *prev_y : 0.0f;
    const float one_minus_alpha = 1.0f - alpha;

    for (int n = 0; n < n_samples; ++n) {
        float y = one_minus_alpha * in_audio[n] + alpha * py;
        out_audio[n] = y;
        py = y;
    }

    if (prev_y) *prev_y = py;
    return n_samples;
}

/**
 * 7. Fast Linear Resampling:
 * Resamples in_audio (size in_len) to out_audio (size out_len).
 */
DSP_EXPORT int dsp_resample_linear(
    const float* in_audio,
    int in_len,
    float* out_audio,
    int out_len
) {
    if (!in_audio || !out_audio || in_len < 2 || out_len <= 0) return 0;

    const double step = (double)(in_len - 1) / (double)(out_len > 1 ? out_len - 1 : 1);

    for (int i = 0; i < out_len; ++i) {
        double pos = (double)i * step;
        int idx = (int)pos;
        if (idx >= in_len - 1) {
            out_audio[i] = in_audio[in_len - 1];
        } else {
            float frac = (float)(pos - idx);
            out_audio[i] = in_audio[idx] * (1.0f - frac) + in_audio[idx + 1] * frac;
        }
    }
    return out_len;
}

/**
 * 8. Float32 to Int16 PCM conversion with clipping.
 */
DSP_EXPORT int dsp_float_to_int16(
    const float* in_audio,
    int n_samples,
    float gain,
    int16_t* out_pcm
) {
    if (!in_audio || !out_pcm || n_samples <= 0) return 0;

    for (int n = 0; n < n_samples; ++n) {
        float val = in_audio[n] * gain;
        if (val > 1.0f) val = 1.0f;
        else if (val < -1.0f) val = -1.0f;
        out_pcm[n] = (int16_t)(val * 32767.0f);
    }
    return n_samples;
}
