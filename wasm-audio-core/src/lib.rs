use std::f32::consts::PI;
use wasm_bindgen::prelude::*;

pub mod streaming_decoder;
pub use streaming_decoder::{
    inspect_and_index_audio_container, SafeStreamingDecodeSummary, WasmSeekTableEntry,
};

/// Streaming 4-level Int8 Peak Pyramid Builder (64, 256, 1024, 4096 samples/pixel).
/// Built incrementally during chunked decode so multi-hour audio never buffers full Float32 PCM in RAM.
#[wasm_bindgen]
pub struct StreamingPeakPyramidBuilder {
    lod_64_min: Vec<i8>,
    lod_64_max: Vec<i8>,
    lod_256_min: Vec<i8>,
    lod_256_max: Vec<i8>,
    lod_1024_min: Vec<i8>,
    lod_1024_max: Vec<i8>,
    lod_4096_min: Vec<i8>,
    lod_4096_max: Vec<i8>,

    cur_64_min: f32,
    cur_64_max: f32,
    count_64: usize,

    cur_256_min: i8,
    cur_256_max: i8,
    count_256: usize,

    cur_1024_min: i8,
    cur_1024_max: i8,
    count_1024: usize,

    cur_4096_min: i8,
    cur_4096_max: i8,
    count_4096: usize,

    finalized: bool,
}

#[wasm_bindgen]
impl StreamingPeakPyramidBuilder {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            lod_64_min: Vec::with_capacity(4096),
            lod_64_max: Vec::with_capacity(4096),
            lod_256_min: Vec::with_capacity(1024),
            lod_256_max: Vec::with_capacity(1024),
            lod_1024_min: Vec::with_capacity(256),
            lod_1024_max: Vec::with_capacity(256),
            lod_4096_min: Vec::with_capacity(64),
            lod_4096_max: Vec::with_capacity(64),
            cur_64_min: 1.0,
            cur_64_max: -1.0,
            count_64: 0,
            cur_256_min: 127,
            cur_256_max: -127,
            count_256: 0,
            cur_1024_min: 127,
            cur_1024_max: -127,
            count_1024: 0,
            cur_4096_min: 127,
            cur_4096_max: -127,
            count_4096: 0,
            finalized: false,
        }
    }

    #[inline]
    fn float_to_i8(val: f32) -> i8 {
        (val.clamp(-1.0, 1.0) * 127.0).round() as i8
    }

    fn push_lod_64_bucket(&mut self, min_i8: i8, max_i8: i8) {
        self.lod_64_min.push(min_i8);
        self.lod_64_max.push(max_i8);

        self.cur_256_min = self.cur_256_min.min(min_i8);
        self.cur_256_max = self.cur_256_max.max(max_i8);
        self.count_256 += 1;

        if self.count_256 == 4 {
            self.push_lod_256_bucket(self.cur_256_min, self.cur_256_max);
            self.cur_256_min = 127;
            self.cur_256_max = -127;
            self.count_256 = 0;
        }
    }

    fn push_lod_256_bucket(&mut self, min_i8: i8, max_i8: i8) {
        self.lod_256_min.push(min_i8);
        self.lod_256_max.push(max_i8);

        self.cur_1024_min = self.cur_1024_min.min(min_i8);
        self.cur_1024_max = self.cur_1024_max.max(max_i8);
        self.count_1024 += 1;

        if self.count_1024 == 4 {
            self.push_lod_1024_bucket(self.cur_1024_min, self.cur_1024_max);
            self.cur_1024_min = 127;
            self.cur_1024_max = -127;
            self.count_1024 = 0;
        }
    }

    fn push_lod_1024_bucket(&mut self, min_i8: i8, max_i8: i8) {
        self.lod_1024_min.push(min_i8);
        self.lod_1024_max.push(max_i8);

        self.cur_4096_min = self.cur_4096_min.min(min_i8);
        self.cur_4096_max = self.cur_4096_max.max(max_i8);
        self.count_4096 += 1;

        if self.count_4096 == 4 {
            self.lod_4096_min.push(self.cur_4096_min);
            self.lod_4096_max.push(self.cur_4096_max);
            self.cur_4096_min = 127;
            self.cur_4096_max = -127;
            self.count_4096 = 0;
        }
    }

    pub fn push_samples(&mut self, samples: &[f32]) {
        if self.finalized {
            self.finalized = false;
        }
        for &s in samples {
            if s < self.cur_64_min {
                self.cur_64_min = s;
            }
            if s > self.cur_64_max {
                self.cur_64_max = s;
            }
            self.count_64 += 1;

            if self.count_64 == 64 {
                let min_i8 = Self::float_to_i8(self.cur_64_min);
                let max_i8 = Self::float_to_i8(self.cur_64_max);
                self.push_lod_64_bucket(min_i8, max_i8);

                self.cur_64_min = 1.0;
                self.cur_64_max = -1.0;
                self.count_64 = 0;
            }
        }
    }

    /// Flushes partial trailing buckets (< 64 / 256 / 1024 / 4096 samples) at EOF
    /// so the tail of short or unaligned recordings is preserved in all LOD tiers.
    pub fn finalize(&mut self) {
        if self.finalized {
            return;
        }
        if self.count_64 > 0 {
            let min_i8 = Self::float_to_i8(self.cur_64_min);
            let max_i8 = Self::float_to_i8(self.cur_64_max);
            self.push_lod_64_bucket(min_i8, max_i8);
            self.cur_64_min = 1.0;
            self.cur_64_max = -1.0;
            self.count_64 = 0;
        }
        if self.count_256 > 0 {
            self.push_lod_256_bucket(self.cur_256_min, self.cur_256_max);
            self.cur_256_min = 127;
            self.cur_256_max = -127;
            self.count_256 = 0;
        }
        if self.count_1024 > 0 {
            self.push_lod_1024_bucket(self.cur_1024_min, self.cur_1024_max);
            self.cur_1024_min = 127;
            self.cur_1024_max = -127;
            self.count_1024 = 0;
        }
        if self.count_4096 > 0 {
            self.lod_4096_min.push(self.cur_4096_min);
            self.lod_4096_max.push(self.cur_4096_max);
            self.cur_4096_min = 127;
            self.cur_4096_max = -127;
            self.count_4096 = 0;
        }
        self.finalized = true;
    }

    pub fn take_lod_64_interleaved(&self) -> Vec<i8> {
        let mut out = Vec::with_capacity(self.lod_64_min.len() * 2);
        for i in 0..self.lod_64_min.len() {
            out.push(self.lod_64_min[i]);
            out.push(self.lod_64_max[i]);
        }
        out
    }

    pub fn take_lod_256_interleaved(&self) -> Vec<i8> {
        let mut out = Vec::with_capacity(self.lod_256_min.len() * 2);
        for i in 0..self.lod_256_min.len() {
            out.push(self.lod_256_min[i]);
            out.push(self.lod_256_max[i]);
        }
        out
    }

    pub fn take_lod_1024_interleaved(&self) -> Vec<i8> {
        let mut out = Vec::with_capacity(self.lod_1024_min.len() * 2);
        for i in 0..self.lod_1024_min.len() {
            out.push(self.lod_1024_min[i]);
            out.push(self.lod_1024_max[i]);
        }
        out
    }

    pub fn take_lod_4096_interleaved(&self) -> Vec<i8> {
        let mut out = Vec::with_capacity(self.lod_4096_min.len() * 2);
        for i in 0..self.lod_4096_min.len() {
            out.push(self.lod_4096_min[i]);
            out.push(self.lod_4096_max[i]);
        }
        out
    }
}

/// Stateful Persian Voice DSP Chain (80Hz HPF + Hysteresis/Hold Gate + Speech Compressor).
/// Designed for Zero-Copy WASM linear memory writes and seamless Pre-Roll warmup on random seeks.
#[wasm_bindgen]
pub struct StatefulPersianVoiceDsp {
    sample_rate: f32,
    work_buffer: Vec<f32>,

    // Biquad 80Hz High-Pass Filter coefficients & delay state
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,

    // Hysteresis + Hold Noise Gate (prevents clipping trailing Persian Ezafe/vowels)
    gate_open_thresh_lin: f32,
    gate_close_thresh_lin: f32,
    gate_hold_samples: usize,
    gate_hold_counter: usize,
    gate_is_open: bool,
    gate_gain: f32,

    // Envelope speech compressor
    comp_thresh_db: f32,
    comp_ratio: f32,
    comp_envelope: f32,
}

#[wasm_bindgen]
impl StatefulPersianVoiceDsp {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32, max_block_frames: usize) -> Self {
        let mut dsp = Self {
            sample_rate,
            work_buffer: vec![0.0; max_block_frames.max(128)],
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
            gate_open_thresh_lin: Self::db_to_lin(-38.0),
            gate_close_thresh_lin: Self::db_to_lin(-42.0), // 4 dB hysteresis band
            gate_hold_samples: (sample_rate * 0.120) as usize, // 120ms hold time
            gate_hold_counter: 0,
            gate_is_open: false,
            gate_gain: 0.0,
            comp_thresh_db: -18.0,
            comp_ratio: 3.0,
            comp_envelope: 0.0,
        };
        dsp.compute_hpf_coeffs(80.0, 0.7071);
        dsp
    }

    #[inline]
    fn db_to_lin(db: f32) -> f32 {
        10.0_f32.powf(db / 20.0)
    }

    fn compute_hpf_coeffs(&mut self, cutoff_hz: f32, q: f32) {
        let w0 = 2.0 * PI * cutoff_hz / self.sample_rate;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * q);
        let a0 = 1.0 + alpha;

        self.b0 = ((1.0 + cos_w0) * 0.5) / a0;
        self.b1 = (-(1.0 + cos_w0)) / a0;
        self.b2 = ((1.0 + cos_w0) * 0.5) / a0;
        self.a1 = (-2.0 * cos_w0) / a0;
        self.a2 = (1.0 - alpha) / a0;
    }

    /// Pointer in WASM linear memory for Zero-Copy JS Float32Array view writes.
    pub fn get_work_buffer_ptr(&mut self) -> *mut f32 {
        self.work_buffer.as_mut_ptr()
    }

    pub fn get_work_buffer_len(&self) -> usize {
        self.work_buffer.len()
    }

    /// Required Pre-Roll samples (150ms) so stateful filters & compressor envelope settle
    /// cleanly before rendering the visible/audible target segment.
    pub fn required_pre_roll_samples(&self) -> usize {
        (self.sample_rate * 0.150).round() as usize
    }

    /// Resets stateful filter & envelope memories consistently prior to feeding Pre-Roll.
    pub fn reset_state(&mut self) {
        self.x1 = 0.0;
        self.x2 = 0.0;
        self.y1 = 0.0;
        self.y2 = 0.0;
        self.gate_is_open = false;
        self.gate_hold_counter = 0;
        self.gate_gain = 0.0;
        self.comp_envelope = 0.0;
    }

    pub fn configure_gate(&mut self, open_thresh_db: f32, hysteresis_db: f32, hold_ms: f32) {
        self.gate_open_thresh_lin = Self::db_to_lin(open_thresh_db);
        self.gate_close_thresh_lin = Self::db_to_lin(open_thresh_db - hysteresis_db.abs());
        self.gate_hold_samples = ((self.sample_rate * hold_ms.max(0.0)) / 1000.0).round() as usize;
    }

    /// Processes `active_len` samples in-place inside `work_buffer`.
    pub fn process_in_place(
        &mut self,
        active_len: usize,
        enable_hpf: bool,
        enable_gate: bool,
        enable_comp: bool,
        makeup_gain_db: f32,
    ) {
        let len = active_len.min(self.work_buffer.len());
        let makeup_lin = Self::db_to_lin(makeup_gain_db);
        let attack_coeff = (-1.0 / (0.005 * self.sample_rate)).exp();
        let release_coeff = (-1.0 / (0.080 * self.sample_rate)).exp();

        for i in 0..len {
            let mut s = self.work_buffer[i];

            // 1. 80Hz High-Pass Butterworth Biquad
            if enable_hpf {
                let y = self.b0 * s + self.b1 * self.x1 + self.b2 * self.x2
                    - self.a1 * self.y1
                    - self.a2 * self.y2;
                self.x2 = self.x1;
                self.x1 = s;
                self.y2 = self.y1;
                self.y1 = y;
                s = y;
            }

            // 2. Noise Gate with Hysteresis & Hold Timer
            if enable_gate {
                let abs_s = s.abs();
                if abs_s >= self.gate_open_thresh_lin {
                    self.gate_is_open = true;
                    self.gate_hold_counter = self.gate_hold_samples;
                } else if self.gate_is_open {
                    if abs_s >= self.gate_close_thresh_lin {
                        self.gate_hold_counter = self.gate_hold_samples;
                    } else if self.gate_hold_counter > 0 {
                        self.gate_hold_counter -= 1;
                    } else {
                        self.gate_is_open = false;
                    }
                }

                let target_gate = if self.gate_is_open { 1.0 } else { 0.08 };
                let slew = if target_gate > self.gate_gain { 0.015 } else { 0.002 };
                self.gate_gain += (target_gate - self.gate_gain) * slew;
                s *= self.gate_gain;
            }

            // 3. Speech Compressor
            if enable_comp {
                let abs_s = s.abs().max(1e-7);
                if abs_s > self.comp_envelope {
                    self.comp_envelope = attack_coeff * self.comp_envelope + (1.0 - attack_coeff) * abs_s;
                } else {
                    self.comp_envelope = release_coeff * self.comp_envelope + (1.0 - release_coeff) * abs_s;
                }

                let env_db = 20.0 * self.comp_envelope.log10();
                if env_db > self.comp_thresh_db {
                    let over = env_db - self.comp_thresh_db;
                    let compressed_over = over / self.comp_ratio;
                    let gain_reduction_db = compressed_over - over;
                    s *= Self::db_to_lin(gain_reduction_db);
                }
                s *= makeup_lin;
            }

            // 4. Soft Clipping Guard
            self.work_buffer[i] = if s > 0.98 {
                0.98 + (s - 0.98).tanh() * 0.02
            } else if s < -0.98 {
                -0.98 + (s + 0.98).tanh() * 0.02
            } else {
                s
            };
        }
    }
}

/// Zero-Copy WASM memory allocation helpers for AudioRestorationEngine.ts
#[wasm_bindgen]
pub fn alloc_f32(len: usize) -> *mut f32 {
    let mut buf = Vec::<f32>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[wasm_bindgen]
pub unsafe fn free_f32(ptr: *mut f32, len: usize) {
    if !ptr.is_null() && len > 0 {
        let _ = Vec::from_raw_parts(ptr, 0, len);
    }
}

/// Cubic Hermite De-Clip kernel running directly in WASM linear memory.
#[wasm_bindgen]
pub unsafe fn de_clip_in_place(ptr: *mut f32, len: usize, threshold: f32, auto_headroom: u8) -> usize {
    if ptr.is_null() || len < 8 {
        return 0;
    }
    let samples = std::slice::from_raw_parts_mut(ptr, len);
    let thresh = threshold.clamp(0.8, 0.9999) - 1e-5;
    let mut repaired = 0usize;
    let mut max_peak = 0.0_f32;
    let mut i = 2usize;

    while i < len - 2 {
        let abs_v = samples[i].abs();
        if abs_v < thresh {
            if abs_v > max_peak {
                max_peak = abs_v;
            }
            i += 1;
            continue;
        }
        let sign = samples[i] >= 0.0;
        let start = i;
        let mut end = i;
        while end + 1 < len - 2 && samples[end + 1].abs() >= thresh && (samples[end + 1] >= 0.0) == sign {
            end += 1;
        }
        if end - start + 1 >= 2 {
            let y0 = samples[start - 1];
            let y1 = samples[end + 1];
            let m0 = samples[start - 1] - samples[start - 2];
            let m1 = samples[end + 2] - samples[end + 1];
            let span = (end - start + 2) as f32;
            for k in start..=end {
                let t = (k - (start - 1)) as f32 / span;
                let t2 = t * t;
                let t3 = t2 * t;
                let val = (2.0 * t3 - 3.0 * t2 + 1.0) * y0
                    + (t3 - 2.0 * t2 + t) * (m0 * span)
                    + (-2.0 * t3 + 3.0 * t2) * y1
                    + (t3 - t2) * (m1 * span);
                samples[k] = val.clamp(-2.5, 2.5);
                max_peak = max_peak.max(samples[k].abs());
            }
            repaired += 1;
        }
        i = end + 2;
    }

    if auto_headroom != 0 && max_peak > 0.96 {
        let scale = 0.96 / max_peak;
        for s in samples.iter_mut() {
            *s *= scale;
        }
    }
    repaired
}

/// High-pass impulsive De-Click kernel with Catmull-Rom cubic repair in WASM linear memory.
#[wasm_bindgen]
pub unsafe fn de_click_in_place(
    ptr: *mut f32,
    len: usize,
    sample_rate: f32,
    sensitivity: f32,
    max_click_ms: f32,
) -> usize {
    if ptr.is_null() || len < 32 {
        return 0;
    }
    let samples = std::slice::from_raw_parts_mut(ptr, len);
    let max_width = ((max_click_ms / 1000.0) * sample_rate).round().max(4.0) as usize;
    let half_win = (0.012 * sample_rate).round().max(64.0) as usize;
    let sens = sensitivity.max(2.5);

    let mut hp = vec![0.0_f32; len];
    for i in 1..len - 1 {
        hp[i] = (samples[i] - 0.5 * (samples[i - 1] + samples[i + 1])).abs();
    }
    let mut prefix = vec![0.0_f64; len + 1];
    for i in 0..len {
        prefix[i + 1] = prefix[i] + hp[i] as f64;
    }

    let mut flagged = vec![0_u8; len];
    let guard = 6usize;
    for i in 2..len - 2 {
        let ls = i.saturating_sub(half_win);
        let le = i.saturating_sub(guard).max(ls);
        let rs = (i + guard + 1).min(len);
        let re = (i + half_win + 1).min(len);
        let count = (le - ls) + (re - rs);
        let mean = if count > 0 {
            ((prefix[le] - prefix[ls]) + (prefix[re] - prefix[rs])) / count as f64
        } else {
            0.0
        };
        if hp[i] > 0.012 && (hp[i] as f64) > mean * sens as f64 {
            flagged[i] = 1;
        }
    }

    let mut clicks = 0usize;
    let mut i = 2usize;
    while i < len - 2 {
        if flagged[i] == 0 {
            i += 1;
            continue;
        }
        let start = i.saturating_sub(1).max(2);
        let mut end = i;
        let mut gap = 0usize;
        let mut j = i + 1;
        while j < len - 2 && gap <= 3 {
            if flagged[j] != 0 {
                end = j;
                gap = 0;
            } else {
                gap += 1;
            }
            j += 1;
        }
        end = (end + 1).min(len - 3);
        if end - start + 1 <= max_width {
            let (p0, p1, p2, p3) = (samples[start - 2], samples[start - 1], samples[end + 1], samples[end + 2]);
            let span = (end - start + 2) as f32;
            for k in start..=end {
                let t = (k - (start - 1)) as f32 / span;
                let t2 = t * t;
                let t3 = t2 * t;
                let v = 0.5
                    * (2.0 * p1
                        + (-p0 + p2) * t
                        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
                        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3);
                samples[k] = v.clamp(-1.0, 1.0);
            }
            clicks += 1;
        }
        i = end + 2;
    }
    clicks
}

/// Real-time 1024-pt STFT Spectral De-Reverb kernel in WASM linear memory.
#[wasm_bindgen]
pub unsafe fn de_reverb_in_place(
    ptr: *mut f32,
    len: usize,
    sample_rate: f32,
    reduction_amount: f32,
    rt60_sec: f32,
) {
    if ptr.is_null() || len < 1024 {
        return;
    }
    let samples = std::slice::from_raw_parts_mut(ptr, len);
    let reduction = reduction_amount.clamp(0.0, 1.0);
    if reduction <= 0.0 {
        return;
    }

    let fft_size = 1024usize;
    let hop_size = 256usize;
    let num_bins = fft_size / 2 + 1;
    let rt60 = rt60_sec.clamp(0.15, 3.0);
    let hop_sec = hop_size as f32 / sample_rate;
    let decay = (-13.8155 * hop_sec / rt60).exp();
    let delay_frames = (0.016 / hop_sec).round().max(2.0) as usize;
    let coupling = 0.22 + reduction * 0.20;
    let sub_factor = 0.6 + reduction * 0.8;

    let window: Vec<f32> = (0..fft_size)
        .map(|i| 0.5 * (1.0 - (2.0 * PI * i as f32 / fft_size as f32).cos()))
        .collect();
    let padded = ((len - fft_size + hop_size - 1) / hop_size) * hop_size + fft_size;
    let mut output = vec![0.0_f32; padded];
    let mut norm = vec![0.0_f32; padded];
    let mut power_ring = vec![vec![0.0_f32; num_bins]; delay_frames];
    let mut ring_idx = 0usize;
    let mut late_reverb = vec![0.0_f32; num_bins];

    let mut re = vec![0.0_f32; fft_size];
    let mut im = vec![0.0_f32; fft_size];

    let mut pos = 0usize;
    while pos + fft_size <= padded {
        for i in 0..fft_size {
            let s = if pos + i < len { samples[pos + i] } else { 0.0 };
            re[i] = s * window[i];
            im[i] = 0.0;
        }
        fft_radix2_f32(&mut re, &mut im, false);

        let mut cur_pow = vec![0.0_f32; num_bins];
        let mut gains = vec![1.0_f32; num_bins];
        for k in 0..num_bins {
            let p = re[k] * re[k] + im[k] * im[k];
            cur_pow[k] = p;
            late_reverb[k] = (decay * late_reverb[k]).max(coupling * power_ring[ring_idx][k]);
            let clean = (p - sub_factor * late_reverb[k]).max(0.0);
            let raw_g = if p > 1e-18 { (clean / p).sqrt() } else { 1.0 };
            gains[k] = raw_g.clamp(0.16, 1.0);
        }

        re[0] *= gains[0];
        im[0] *= gains[0];
        re[fft_size / 2] *= gains[fft_size / 2];
        im[fft_size / 2] *= gains[fft_size / 2];
        for k in 1..fft_size / 2 {
            let g = 0.25 * gains[k - 1] + 0.5 * gains[k] + 0.25 * gains[k + 1];
            re[k] *= g;
            im[k] *= g;
            re[fft_size - k] *= g;
            im[fft_size - k] *= g;
        }

        power_ring[ring_idx] = cur_pow;
        ring_idx = (ring_idx + 1) % delay_frames;

        fft_radix2_f32(&mut re, &mut im, true);
        for i in 0..fft_size {
            let w = window[i];
            output[pos + i] += re[i] * w;
            norm[pos + i] += w * w;
        }
        pos += hop_size;
    }

    for i in 0..len {
        if norm[i] > 1e-9 {
            samples[i] = output[i] / norm[i];
        }
    }
}

fn fft_radix2_f32(re: &mut [f32], im: &mut [f32], inverse: bool) {
    let n = re.len();
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while (j & bit) != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let sign = if inverse { 1.0 } else { -1.0 };
    let mut step = 2usize;
    while step <= n {
        let half = step >> 1;
        let angle = sign * 2.0 * PI / step as f32;
        let (ws_im, ws_re) = angle.sin_cos();
        let mut i = 0usize;
        while i < n {
            let (mut w_re, mut w_im) = (1.0_f32, 0.0_f32);
            for k in 0..half {
                let even = i + k;
                let odd = even + half;
                let o_re = re[odd] * w_re - im[odd] * w_im;
                let o_im = re[odd] * w_im + im[odd] * w_re;
                re[odd] = re[even] - o_re;
                im[odd] = im[even] - o_im;
                re[even] += o_re;
                im[even] += o_im;
                let nw_re = w_re * ws_re - w_im * ws_im;
                w_im = w_re * ws_im + w_im * ws_re;
                w_re = nw_re;
            }
            i += step;
        }
        step <<= 1;
    }
    if inverse {
        let inv = 1.0 / n as f32;
        for i in 0..n {
            re[i] *= inv;
            im[i] *= inv;
        }
    }
}
