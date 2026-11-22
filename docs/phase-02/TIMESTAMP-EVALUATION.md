# AVAPARDAZ — PHASE-02: WORD-LEVEL TIMESTAMP & ALIGNMENT EVALUATION

**Document ID:** `AVP-P02-TS-2.0`  
**Execution ID:** `AVP-P02-RECOVERY-002`  
**Date:** `2026-11-22`  
**Evidence Sources:**
- `benchmarks/phase02/results-2026-11-20.json` (`sha256: 7abb940d90ae3df4176a66dac9280f105c3b7917541019f823e451ca7b866fe9`)
- `benchmarks/phase02/product-fit-results-2026-11-22.json` (`sha256: f75ff6a32f654c1cd8ed1eb4ce5274926dde6f7ab7bb51a42d40c9753a03648d`)
- `benchmarks/phase02/recovery-verification-2026-11-22.json` (`sha256: e8ebdb07764fb55c88d47d796bbdc7f4a1a9f26ed79263f7b8d6e6c7aae82b44`)
- `docs/phase-02/BENCHMARK-PROTOCOL.md` (`sha256: 4b3f76ce3eedc287806e9a75abfc987c402495c146b6a548d90b4896b8a3a945`)
- `docs/phase-02/MODEL-DISCOVERY.md` (`sha256: 5c52407173452884da40e1e6fa0d0b102d11cf4b5fe826b59324aa64e5eb40d0`)

**Test Environment (`ACTUAL_LINUX_CPU_RESULTS`):** `Linux 4.19.0-gvisor x86_64`, `4 vCPU` (`AVX-512 VNNI / AVX2 / SSE4.2`), `12,288 MiB RAM`, `GPU: NONE`, `sherpa-onnx-offline v2.0.2` (`ONNX Runtime 1.28.2 CPU`), `FFmpeg 4.4.2`.  
**Target Hardware (`ACTUAL_APPLE_M2_RESULTS`):** Apple Silicon M2 / 8 GB unified memory — **`NOT_RUN`** (`UNTESTED — PHYSICAL HARDWARE VALIDATION REQUIRED`).

---

## 1. Timestamp Capability Comparison Across Evaluated & Candidate Engines

AVAPARDAZ's downstream smart-editing pipeline (`Speech Event Engine`, `Edit Decision Engine`, `EDL Contracts`, `Audio Render Engine`) requires **word-level start/end boundaries** accurate enough to place non-destructive audio cuts without clipping adjacent phonemes (especially on short Persian fillers, stutters, and repeated takes).

| Engine / Candidate | Exact Checkpoint & Runtime | Native Word/Token Timestamps? | Timestamp Granularity Verified | Frame / Quantization Step | Observed Evidence | Product Cut-Readiness |
| :--- | :--- | :---: | :--- | :---: | :--- | :---: |
| **`C01` `Reza2kn/Shenava-Rizeh v1.0`** | `14ca75f0c5c6` (`model.int8.onnx`) via `sherpa-onnx-offline v2.0.2` | **YES (Native CTC)** `VERIFIED` | **Subword BPE token timestamps** (`tokens` + `timestamps` arrays, 1:1 aligned; whitespace-prefix tokens mark word starts) | `0.08 s` (`80 ms` FastConformer 8× subsampling grid) `MEASURED` | `EVID-01`, `EVID-02`, `EVID-03` | **PROVISIONAL PASS FOR FA** (pending human Praat ground-truth validation) |
| **`C02` `openai/whisper-large-v3-turbo-int8`** | `41f01f3fe87f` via `sherpa-onnx-offline v2.0.2` | **NO** `VERIFIED` | **`SEGMENT`-only** (`timestamps` array empty in `sherpa-onnx` Whisper offline recognizer) | Utterance/chunk level (`<= 30 s`) | `EVID-01` | **FAIL** for direct cut placement without an external forced aligner or alternative runtime |
| **`C03` `Qwen/Qwen3-ASR-0.6B-int8`** | `5eb144179a02` via `sherpa-onnx-offline v2.0.2` | **NO** `VERIFIED` | Utterance-only (`Qwen3-ForcedAligner-0.6B` is a separate model and does **not** list Persian among its primary 11 supported languages) | N/A | `EVID-01`, `MODEL-DISCOVERY.md` | **REJECTED** |
| **`C04`/`C05` `openai/whisper-base` (FP32 / INT8)** | `5359861c739e` via `sherpa-onnx-offline v2.0.2` | **NO** `VERIFIED` | **`SEGMENT`-only** | Utterance/chunk level | `EVID-01` | **REJECTED** |
| **`C07` `whisper.cpp` (Attention DTW)** | `openai/whisper-large-v3-turbo` GGML (`-ml 1` / DTW) | **YES (Attention DTW)** `DOCUMENTED` | Word-level estimated via cross-attention Dynamic Time Warping | Typically `±100–300 ms` jitter `DOCUMENTED` | `NOT_RUN` locally | **UNVERIFIED** (`NOT_RUN`) |
| **External Forced Alignment (`WhisperX` / `wav2vec2` CTC / `Shenava` CTC Aligner)** | Dedicated acoustic CTC aligner post-pass | **YES (Acoustic Forced Alignment)** `DOCUMENTED` | Word / character / phoneme level | `20–80 ms` depending on encoder stride | `NOT_RUN` locally | **RECOMMENDED PATH FOR EN/MULTILINGUAL** (`NOT_RUN`) |

---

## 2. Empirical Measurements on `Reza2kn/Shenava-Rizeh v1.0` (`EVID-02` & `EVID-03`)

### 2.1 Native BPE Token & Timestamp Structural Verification (`EVID-03`)

Across `1` warmup run + `5` cold measured runs (`4` threads, strictly offline) on `test_wavs/0.wav` (`14.466 s`) and `1` verification run on `test_wavs/1.wav` (`2.536 s`):

- **`test_wavs/0.wav` (`14.466 s`):** Emitted `38` BPE tokens and `38` strictly non-decreasing float timestamps (`1:1` pairing) across `5/5` runs with **100.0% byte-identical determinism**.
  - Observed initial token sequence from `EVID-03`:
    `(" اما", 1.52)`, `(" بزرگ", 1.84)`, `(" بابا", 2.16)`, `("ز", 2.48)`, `("رگ", 2.64)`, `(" دیگه", 3.28)`, `(" هیچ", 3.60)`, `(" وقت", 3.68)`.
  - Notice the exact `0.08 s` (`80 ms`) discrete CTC frame quantization grid (`3.68 - 3.60 = 0.08 s`, `2.64 - 2.48 = 0.16 s`, `1.84 - 1.52 = 0.32 s`).
  - Notice that `sherpa-onnx` NeMo CTC exposes **token peak/onset timestamps** (single float per BPE piece), NOT explicit `(start_sec, end_sec)` pairs per word; word end boundaries must be derived via next-token onset, acoustic energy/VAD decay, or CTC frame duration heuristics (not yet benchmarked against human ground truth).
- **`test_wavs/1.wav` (`2.536 s`):** Emitted `11` BPE tokens and `11` timestamps (`(" و", 0.72)`, `(" چ", 0.96)`, `("نان", 1.12)`, `("چه", 1.28)`, `(" به", 1.44)`, `(" آن", 1.60)`, `(" ها", 1.68)`, `(" اعت", 2.00)`, ...), reconstructing `7` Persian words (`"و چنانچه به آن ها اعتماد شود"`).

### 2.2 Controlled Silence-Offset & Take-Boundary Probe (`EVID-02`)

To test whether `Shenava-Rizeh` CTC timestamps drift across long silences or repeated takes, `benchmarks/phase02/run_product_fit_benchmark.py` constructed an exact acoustic probe from `test_wavs/1.wav` (`2.536 s`, clean first-word onset `0.720 s`):

```text
[2.000s pure silence] + [Take 1: wav_1 (2.536s)] + [2.500s pure silence] + [Take 2: wav_1 (2.536s)]
```

| Probe Checkpoint | Expected Onset (`s`) | Observed Onset (`s`) | Absolute Error (`ms`) | Result |
| :--- | ---: | ---: | ---: | :---: |
| **Take 1 First Word (`"و"`)** | `2.720` (`2.000 + 0.720`) | `2.720` | **`0.0 ms`** | `PASS` (exact to frame grid) |
| **Take 2 First Word (`"و"`)** | `7.756` (`2.000 + 2.536 + 2.500 + 0.720`) | `7.760` | **`3.8 ms`** (`4 ms` rounded to `80 ms` grid) | `PASS` |
| **Total Words Emitted** | `14` (`7 + 7`) | `14` | `0` dropped / `0` hallucinated | `PASS` |

**Interpretation (`[Observed Fact]`):** Within a single `12.07 s` clip containing `4.5 s` of inserted silence, `Shenava-Rizeh` exhibits **zero cumulative timeline drift** (`<= 4 ms` alignment error relative to its own clean baseline onset).

### 2.3 Verbatim Repetition Preservation Probe (`EVID-02`)

Because smart audio editors must detect and cut accidental speaker repetitions (rather than letting a language model silently "clean up" or deduplicate them):

- **Constructed Probe:** `wav_1 (2.536 s) + 250 ms silence + wav_1 (2.536 s)` (`14` expected words).
- **Observed `Shenava-Rizeh` Output:** `"و چنانچه به آن ها اعتماد شود و چنانچه به آن ها اعتماد شود"` (`14/14` words, `preserved_verbatim = true`, `cer_vs_expected_pct = 0.0%`).
- **Why this matters architecturally:** CTC acoustic models decode frame-by-frame without an autoregressive decoder prior that collapses repeated phrases, making `Shenava-Rizeh` structurally favorable for verbatim repetition retention. However, **spontaneous human stutters, partial false starts, and Persian fillers (`اِاِ`, `اُم`, `یعنی`, `چیزه`)** have **NOT** been evaluated (`P02-10 = NOT_RUN`).

---

## 3. Critical Evidence Gaps & Known Limitations

1. **No Human Word-Boundary Ground Truth (`NOT_AVAILABLE`):** Zero audio clips with manual Praat / TextGrid word start & end annotations exist in the repository (`docs/phase-02/DATASET-REGISTER.md`). Therefore, real-world human-aligned metrics (`MAE`, `Median`, `P90`, `P95` word-boundary error, and `% words <= 50 ms / 100 ms`) are **`NOT_AVAILABLE`**.
2. **Token-Peak vs. True `(start, end)` Span:** CTC models emit a single peak emission timestamp per subword token (often shifted slightly late relative to acoustic phoneme onset — known as CTC emission delay, typically `40–160 ms` on FastConformer 8× subsampling). Because the `EVID-02` offset probe measured shift relative to `wav_1`'s own clean CTC peak (`0.720 s`), **absolute acoustic CTC emission lag has NOT been measured against human boundaries**.
3. **Zero Timestamp Verification on Multilingual / English Path:** `whisper-large-v3-turbo-int8` in `sherpa-onnx` outputs **no word timestamps**, and neither `whisper.cpp` DTW nor an external forced aligner (`wav2vec2`/CTC) has been benchmarked on disk (`NOT_RUN`).
4. **Long-Form Chunk Stitching Drift Unmeasured:** `EVID-02` tested `12 × 25 s = 300 s` independent chunks, not overlapping-window boundary reconciliation across `30–60 min` continuous speech.

---

## 4. Acceptance Status

- **`P02-11` (Repetition preservation):** **`PARTIAL`** — Verified on 1 controlled real-utterance repetition probe for `Shenava-Rizeh` (`14/14` words); natural spontaneous repetitions and `whisper-large-v3-turbo` repetition behavior are `NOT_RUN`.
- **`P02-12` (Word-level timestamp accuracy):** **`PARTIAL`** — Verified structurally (`1:1` native CTC token timestamps) and via controlled offset probe (`0.0 ms` / `3.8 ms` relative drift) on `Shenava-Rizeh` only; **BLOCKED** for final acceptance because:
  1. Real human word-boundary ground-truth (`Praat/TextGrid`) `P90/P95` error is **`NOT_AVAILABLE`**;
  2. CTC absolute emission-lag calibration is **`NOT_RUN`**;
  3. English/multilingual word-level timestamp path (`whisper-large-v3-turbo` + aligner or `whisper.cpp`) is **`NOT_RUN`**.
