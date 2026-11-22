# AVAPARDAZ — PHASE-02: CPU BENCHMARK RESULTS

**Document ID:** `AVP-P02-CPU-BENCH-2.0`  
**Execution ID:** `AVP-P02-RECOVERY-002`  
**Report Date:** `2026-11-22`  
**Raw Evidence Artifacts (Preserved Untouched):**
1. **`EVID-01`:** `benchmarks/phase02/results-2026-11-20.json` (`90,250 B`, `sha256: 7abb940d90ae3df4176a66dac9280f105c3b7917541019f823e451ca7b866fe9`, executed `2026-11-20T14:35:29Z`)
2. **`EVID-02`:** `benchmarks/phase02/product-fit-results-2026-11-22.json` (`4,680 B`, `sha256: f75ff6a32f654c1cd8ed1eb4ce5274926dde6f7ab7bb51a42d40c9753a03648d`, executed `2026-11-22T16:14:50Z`)
3. **`EVID-03`:** `benchmarks/phase02/recovery-verification-2026-11-22.json` (`6,842 B`, `sha256: e8ebdb07764fb55c88d47d796bbdc7f4a1a9f26ed79263f7b8d6e6c7aae82b44`, executed `2026-11-22T16:25:06Z`)

---

## 1. Strict Hardware Profile Separation

| Hardware Profile | Specification | Execution Status | Extrapolation Policy |
| :--- | :--- | :---: | :--- |
| **`ACTUAL_LINUX_CPU_RESULTS`** *(Available Container)* | `Linux 4.19.0-gvisor x86_64`, `4 vCPU` (`AVX-512 VNNI / AVX2 / SSE4.2`), `12,288 MiB RAM` (`0` swap), `GPU: NONE`, `sherpa-onnx-offline v2.0.2` (`ONNX Runtime 1.28.2 CPU`), `Python 3.11.2`, `FFmpeg 4.4.2` | **`MEASURED`** | Valid **ONLY** for Linux `x86_64` 4-core CPU with `12 GiB` RAM. |
| **`ACTUAL_APPLE_M2_RESULTS`** *(`H1` Primary Target)* | Apple Silicon M2, `8 GB` unified memory, macOS | **`NOT_RUN`** (`H1_M2_BENCHMARK = NOT_RUN`) | **`UNTESTED — PHYSICAL HARDWARE VALIDATION REQUIRED`**. Linux x86_64 numbers are **NOT** extrapolated to M2. |

---

## 2. `ACTUAL_LINUX_CPU_RESULTS` — 5-Model Offline CPU Bake-Off (`EVID-01`)

**Dataset:** `25` real `CC-BY-4.0` Google FLEURS `dev` WAVs (`277.33s` total: `10` FA = `100.02s`, `10` EN = `88.70s`, `5` `fa-en-concat` = `88.61s`).  
**Formula:** `RTF = decode_sec / audio_duration_sec` (lower is faster; `< 1.0` is faster than real-time).

### 2.1 Accuracy & Language Performance

| Model ID | Quantization | Disk (`MiB`) | **FA Norm CER** (Raw) | **FA Norm WER** (Raw) | **EN Norm WER** (Raw) | **CS (`fa-en-concat`) Norm CER** (Raw) | **CS Norm WER** (Raw) | **CS Latin Recall** |
| :--- | :---: | ---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`Reza2kn/Shenava-Rizeh`** (`14ca75f0c5c6`) | INT8 ONNX | `36.43` | **`5.71%`** (`7.58%`) | **`19.44%`** (`32.12%`) | `100.00%` (`100.00%`) | `65.23%` (`66.24%`) | `74.14%` (`77.91%`) | `0.00%` |
| **`openai/whisper-large-v3-turbo-int8`** (`41f01f3fe87f`) | INT8 ONNX | `988.59` | **`7.71%`** (`8.71%`) | **`27.78%`** (`35.77%`) | **`5.83%`** (`10.86%`) | `63.90%` (`64.62%`) | `67.82%` (`70.93%`) | `17.50%` |
| **`openai/whisper-base-fp32`** | FP32 ONNX | `278.90` | `29.57%` (`32.87%`) | `85.42%` (`93.43%`) | `12.56%` (`16.29%`) | `73.75%` (`74.76%`) | `90.23%` (`90.12%`) | `5.00%` |
| **`openai/whisper-base-int8`** | INT8 ONNX | `153.17` | `44.57%` (`46.91%`) | `103.47%` (`110.95%`) | `13.00%` (`17.65%`) | `78.52%` (`79.29%`) | `105.75%` (`105.81%`) | `0.00%` |
| **`Qwen/Qwen3-ASR-0.6B-int8`** (`5eb144179a02`) | INT8 ONNX | `941.28` | `56.57%` (`56.60%`) | `74.31%` (`75.18%`) | `13.00%` (`15.84%`) | **`48.06%`** (`48.76%`) | **`56.90%`** (`58.14%`) | **`72.01%`** |

### 2.2 Latency, Throughput (`RTF`), Memory (`RSS`) & Raw Telemetry Integrity

| Model ID | Cold Start (`ms`) | Single-Stream `1x` RTF | Overall `25`-Clip RTF | Total Decode (`s`) | Total Wall (`s`) | Peak RSS `1x` (`MiB`) | Peak RSS Batch (`MiB`, batch) | Raw JSON `offline_verified` |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| **`Reza2kn/Shenava-Rizeh`** | `2,128.0` | **`0.0331`** | **`0.0360`** (`27.8×` RT) | `9.988` | `19.289` | **`165.81`** | `836.13` (`b=5`) | `true` |
| **`openai/whisper-large-v3-turbo-int8`** | `7,519.0` | `0.6976` | **`0.6121`** (`1.63×` RT) | `169.761` | `276.470` | `1,382.88` | `1,823.38` (`b=5`) | **`false`** *(see Note A)* |
| **`openai/whisper-base-fp32`** | `2,732.0` | `0.2686` | `0.2372` (`4.22×` RT) | `65.772` | `68.484` | `526.31` | `675.50` (`b=25`) | `true` |
| **`openai/whisper-base-int8`** | `1,882.0` | `0.2462` | `0.2314` (`4.32×` RT) | `64.165` | `66.155` | `326.68` | `504.68` (`b=25`) | `true` |
| **`Qwen/Qwen3-ASR-0.6B-int8`** | `11,612.0` | `0.6030` | `0.9970` (`1.00×` RT) | `276.493` | `354.340` | `1,588.21` | `2,292.48` (`b=5`) | `true` |

> **Forensic Note A (`whisper-large-v3-turbo-int8` Telemetry Anomaly):** Raw `EVID-01` records `"offline_verified": false` and `subsets.en.total_inference_sec = 0.0` / `rtf = 0.0` due to a partial recovery re-run of 10 samples (Whisper BPE split-byte UTF-8 issue) under `batch_size=1`. While `recovery_note` states the re-run used identical offline proxy-blackhole env (`rc=0` on `25/25`), a clean unpatched single-pass run is required to flip `offline_verified` to `true` and populate per-subset `en` timing.

### 2.3 Paired Bootstrap Statistical Significance (`2,000` Resamples, `seed=42`, `95% CI`)

| Subset | Metric | Candidate vs. Baseline | Delta (`pp`) | `95% CI` (`pp`) | Statistically Significant? |
| :--- | :--- | :--- | ---: | :---: | :---: |
| `fa` | `norm_cer` | `Shenava-Rizeh` vs `whisper-base-fp32` | **`-23.857`** | `[-29.197, -19.009]` | **YES** |
| `fa` | `norm_cer` | `Shenava-Rizeh` vs `whisper-large-v3-turbo-int8` | `-2.000` | `[-4.623, +0.857]` | No (near-tie; Shenava `17×` faster & `8.3×` lower RSS) |
| `fa` | `norm_cer` | `whisper-large-v3-turbo-int8` vs `whisper-base-fp32` | **`-21.857`** | `[-26.594, -17.300]` | **YES** |
| `fa` | `norm_cer` | `whisper-base-int8` vs `whisper-base-fp32` | **`+15.000`** | `[+0.740, +34.222]` | **YES (Severe Quantization Regression)** |
| `fa` | `norm_cer` | `whisper-large-v3-turbo-int8` vs `Qwen3-ASR-0.6B-int8` | **`-48.857`** | `[-77.326, -21.302]` | **YES** |
| `en` | `norm_wer` | `whisper-large-v3-turbo-int8` vs `whisper-base-fp32` | **`-6.726`** | `[-11.538, -2.203]` | **YES** |
| `en` | `norm_wer` | `whisper-large-v3-turbo-int8` vs `Qwen3-ASR-0.6B-int8` | **`-7.175`** | `[-15.929, -0.441]` | **YES** |
| `fa-en-concat` | `norm_cer` | `whisper-large-v3-turbo-int8` vs `Qwen3-ASR-0.6B-int8` | `+15.836` | `[-9.790, +39.149]` | No (wide variance) |

---

## 3. `ACTUAL_LINUX_CPU_RESULTS` — Thread Scaling, Stress & Recovery Verification (`EVID-02` & `EVID-03`)

Executed strictly offline on installed `Reza2kn/Shenava-Rizeh v1.0` (`model.int8.onnx`, `sha256: 6bdd4ab8...`) using `test_wavs/0.wav` (`14.466s`).

### 3.1 CPU Thread Scaling (`EVID-02`)

| `--num-threads` | Cold Start (`ms`) | Decode (`s`) | Total Wall (`s`) | `RTF` | CPU Util (`%` of 1 core) | Peak RSS (`MiB`) | Exit Code |
| :-: | ---: | ---: | ---: | ---: | ---: | ---: | :-: |
| `1` | `1,936.0` | `0.677` | `2.6715` | `0.0468` | `98.1%` | `200.20` | `0` |
| `2` | `1,873.0` | `0.528` | `2.4564` | `0.0365` | `118.9%` | `199.87` | `0` |
| `4` | `1,665.0` | `0.433` | `2.1477` | **`0.0299`** | `151.3%` | `204.09` | `0` |

### 3.2 Independent Recovery Repeatability Probe (`EVID-03`, `2026-11-22T16:25:06Z`, 1 Warmup + 5 Measured Cold Runs, 4 Threads)

- **Exit codes:** `5/5` (`rc = 0`), **100% deterministic transcript** (`38` BPE tokens, `38` timestamps per run).
- **Cold Start Median:** `1,792.0 ms` (range `1,777.0–1,990.0 ms`).
- **Decode Time Median:** `0.455 s` (min `0.446 s`, max `0.468 s`) -> **True Median RTF = `0.455 / 14.466 = 0.0315`** (range `0.0308–0.0324`).
  - *Forensic Audit Note on `EVID-03` raw JSON:* The raw JSON field `rtf` captured `0.455` (numerator of `sherpa-onnx` stdout `0.455 / 14.466 = 0.031`) instead of the quotient; the raw artifact is preserved untouched and the exact quotient `decode_sec / 14.466 = 0.0315` is computed transparently here.
- **Total Cold Wall Time Median:** `2.3019 s` (end-to-end cold-process wall RTF including `~1.79s` model load = `0.1591`).
- **Children Peak RSS:** `204.50 MiB`.

### 3.3 Acoustic Stress Drift on `Shenava-Rizeh` (`EVID-02`, vs Clean `0.wav` Baseline)

| Stress Condition | CER Drift vs. Clean Baseline | Observation |
| :--- | ---: | :--- |
| `15 dB` SNR White Noise | `36.47%` | Substantial degradation under broadband stationary noise; front-end denoising / VAD recommended. |
| `8 dB` SNR White Noise | `44.71%` | Severe degradation at low SNR (`< 10 dB`). |
| `0.85×` Slow Speech (`atempo`) | `18.82%` | Moderate tempo sensitivity. |
| `1.20×` Fast Speech (`atempo`) | `24.71%` | Fast conversational speech degrades distilled 32M CTC more than slower speech. |

---

## 4. `ACTUAL_APPLE_M2_RESULTS` (`H1` Target Profile)

| Metric | Apple Silicon M2 (`8 GB` Unified Memory) Result | Status |
| :--- | :--- | :---: |
| `Reza2kn/Shenava-Rizeh` CPU RTF / Cold Start / Peak RSS | `NOT_RUN` | **`UNTESTED — PHYSICAL HARDWARE VALIDATION REQUIRED`** |
| `openai/whisper-large-v3-turbo-int8` CPU RTF / Cold Start / Peak RSS | `NOT_RUN` | **`UNTESTED — PHYSICAL HARDWARE VALIDATION REQUIRED`** |
| Dual-Model Memory Residency (`8 GB` Unified Memory Budget) | `NOT_RUN` | **`UNTESTED — PHYSICAL HARDWARE VALIDATION REQUIRED`** |

---

## 5. Known Limitations & Unverified Assumptions

1. **No M2 Execution:** `H1_M2_BENCHMARK = NOT_RUN`. Linux `x86_64` AVX-512 VNNI performance cannot be assumed to predict Apple Silicon M2 ARM64 NEON latency or unified memory pressure.
2. **Legacy Doc Correction:** `docs/AVAPARDAZ/PHASE-02-RUNTIME-COMPATIBILITY.md` claimed `"Sub-100ms cold start"` for `Shenava-Rizeh`. Measured Linux cold start is **`1,665–2,128 ms`** (`1.7–2.1s`), not `< 100 ms` (warm in-memory decode is `~0.43–0.46s` for `14.5s` of audio).
3. **Acceptance Status:** `P02-06`, `P02-07`, `P02-08` = **`PASS`**; `P02-13` (CPU RTF) & `P02-14` (Peak Memory) = **`PARTIAL`** due to `H1_M2_BENCHMARK = NOT_RUN`.
