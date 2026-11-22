# AVAPARDAZ — PHASE-02 RECOVERY-003 ALIGNMENT & TIMESTAMP EVALUATION REPORT

**Document ID:** `AVP-P02-REC003-ALIGN-001`  
**Execution Series:** `AVP-P02-RECOVERY-003` / `RECOVERY-004` / `RECOVERY-005`  
**Date (UTC):** `2026-11-22`  
**Primary Raw Evidence:** `evidence/phase02/recovery-003/02_whisper_cpp_and_alignment_eval.json` (`sha256: 50cc4035ca739d5b76bcd9ee7565f5652f1fe3cd456988c26f592aed84165f56`)  
**Generated TextGrids / DTW JSONs:** `evidence/phase02/recovery-003/textgrids/` (`31` files, SHA-256 indexed in `EVIDENCE_MANIFEST.sha256`)

---

## 1. Root Cause Confirmed: Why `sherpa-onnx` Whisper Turbo Emits No Native Word Timestamps

Direct execution of `sherpa-onnx v2.0.2` C++ runtime with `openai/whisper-large-v3-turbo INT8` (`turbo-decoder.int8.onnx`, `sha256: 20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547`) emits the deterministic runtime diagnostic on stderr:

```text
Warning: enable_token_timestamps=true but the decoder model does not have cross-attention outputs
```

**Conclusion:** The exported ONNX Whisper Turbo decoder graph omits cross-attention weights required for DTW/attention token timing. Therefore, word-level edit-grade timestamps for Whisper outputs **must** come from either a separate runtime (e.g., `whisper.cpp` DTW) or an acoustic forced aligner (`sherpa-onnx-fa`).

---

## 2. Empirical Benchmark: `whisper.cpp v1.9.5` (DTW) vs. `sherpa-onnx-fa` (`english-mfa-v3.1.0`) vs. `Shenava-Rizeh` (Native CTC)

All runs executed strictly offline inside Linux kernel network namespaces (`unshare -r -n`), CPU-only (`4` threads).

### 2.1 `whisper.cpp v1.9.5` CPU Evaluation (`ggml-large-v3-turbo-q5_0.bin`, MIT)

- **Build:** Compiled natively from source (`git commit d1be6fde11ac6e0407606b4e42fe72d34add8037`, `AVX512_VNNI=1`, `OPENMP=1`, `--no-gpu`, 4 threads).
- **Model SHA-256:** `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2`.
- **Flags:** `-ml 1 -dtw large.v3.turbo` for EN word-level DTW output.

| Subset | Clips | Mean CPU RTF | Load Time (ms) | Peak RSS (MiB) | Notable Observed Issues |
| --- | ---: | ---: | ---: | ---: | --- |
| English (`-ml 1 -dtw`) | 3 (`fleurs-en-dev-0101..0103`) | **`5.1497`** | `1,191–1,233` | `828.59` | **FAILS `RTF <= 1.00` by `5.15×`**; severe subword fragmentation on proper nouns (`fleurs-en-dev-0103`: `93.75%` norm WER due to `"NH K ... K ashi w az aki - K ari wa ... Pre fecture"`) |
| Persian (`fa`) | 3 (`fleurs-fa-dev-0101,0102,0104`) | **`3.4759`** | `1,202–1,232` | `831.38` | **FAILS `RTF <= 1.00` by `3.48×`** (Norm CER `2.22%–5.19%`, Norm WER `11.11%–18.52%`) |

**Verdict on `whisper.cpp v1.9.5` (Linux x86_64 CPU):** **REJECTED** as primary CPU ASR/alignment engine (`3.5–5.1×` slower than real-time, `~8×` slower than `sherpa-onnx-offline` Whisper Turbo INT8, and produces fragmented DTW tokens).

### 2.2 `sherpa-onnx-fa` (`english-mfa-v3.1.0`, `CC-BY-4.0`, Native C++ Acoustic GMM Forced Alignment)

- **Model Artifact (`final.alimdl`) SHA-256:** `1780c629972e968a2fc4a7808c0076945df62865a0acb6ad09a02feed8d74edf`
- **Scope Evaluated:** `25` held-out English clips (`fleurs-en-dev-0101..0126`, excluding `0109`), `529` total input words.

| Metric | Observed Result (`EXP2`) | Gate Assessment |
| --- | ---: | --- |
| Clips Succeeded | **`25 / 25`** (`100%`) | **PASS** |
| `WORD_TIMESTAMP_COVERAGE` | **`1.0000`** (`529 / 529` words aligned) | **PASS** |
| `INVALID_INTERVAL_COUNT` | **`0`** | **PASS** |
| `MISSING_ALIGNMENT_COUNT` | **`0`** | **PASS** |
| `OVERLAPPING_INTERVAL_COUNT` | **`0`** | **PASS** |
| TextGrid Structural Validation (`validate_textgrid.py`) | **`25 / 25` valid** | **PASS** |
| Aligner CPU RTF | **`0.01043`** (`96×` faster than real-time) | **PASS** |
| Cold Start Median | **`1,503.0 ms`** | **PASS** |
| Peak RSS | **`169.18 MiB`** | **PASS** |
| Human Praat Ground-Truth Boundary Error (ms) | **`NOT_AVAILABLE`** (`0` manual Praat TextGrids on disk) | **BLOCKED (External)** |

### 2.3 Inter-System Divergence: Acoustic MFA vs. `whisper.cpp` DTW (`INTER_SYSTEM_DIVERGENCE_ONLY`)

Comparing `whisper.cpp` DTW word intervals against `sherpa-onnx-fa` acoustic MFA on the 3 shared EN clips exposes large DTW timing jitter (strictly reported as inter-system divergence, **not** human ground-truth error):

| Sample ID | Ref Words (MFA) | Hyp Words (`wcpp` DTW) | Matched | Median Boundary Diff (ms) | P90 Diff (ms) | P95 Diff (ms) | Missing / Extra |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `fleurs-en-dev-0101` | 18 | 19 | 18 | `100.0` | `790.0` | `835.0` | `0 / 1` |
| `fleurs-en-dev-0102` | 19 | 19 | 19 | `240.0` | `1,600.0` | `1,935.0` | `0 / 0` |
| `fleurs-en-dev-0103` | 16 | 26 | 11 | `460.0` | `1,490.0` | `1,689.5` | `5 / 15` |

---

## 3. Persian Word-Timestamp Alignment Audit (`CRITICAL GAP`)

1. **MFA Persian Availability in `sherpa-onnx` `fa-models`:** **`false`** — No prebuilt Persian acoustic forced-alignment model is distributed in the `sherpa-onnx` `fa-models` release registry.
2. **`Reza2kn/Shenava-Rizeh v1.0 INT8` Native CTC Timing (`25` held-out FA clips):**
   - `465 / 465` emitted Persian words carry onset timestamps (**`100.0%`** word-onset coverage).
   - **`0`** non-monotonic timestamps, **`0`** out-of-bounds timestamps.
   - **Technical Limitation:** FastConformer CTC frame stride is **`80 ms`**, and native output emits **token peak onset times only** (no explicit acoustic word end boundary).
3. **Human Ground-Truth Gap:** `0` manual Persian Praat TextGrids exist on disk; therefore Persian median/P90/P95 word-boundary error against human ground truth is **`NOT_AVAILABLE`**.

---

## 4. Alignment Recommendations

- **English:** Adopt **`sherpa-onnx-fa` (`english-mfa-v3.1.0`)** as the post-ASR acoustic word aligner (`RTF = 0.01043`, `169 MiB` RSS, `100%` structural integrity, single C++ runtime family with ASR).
- **Persian (Blockers to Clear Before Phase 03):**
  1. Collect `>= 60 min` human Praat TextGrid ground truth (`20%` IAA) to measure true boundary accuracy of `Shenava-Rizeh` CTC onset timestamps and derive optimal acoustic end-boundary heuristics or a dedicated Persian forced aligner.
  2. Do **not** sign off edit-grade Persian word-cut precision until human Praat P90 boundary error is empirically measured.
