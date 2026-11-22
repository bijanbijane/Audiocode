# AVAPARDAZ — PHASE-02: MODEL CANDIDATE MATRIX

**Document ID:** `AVP-P02-MATRIX-2.0`  
**Execution ID:** `AVP-P02-RECOVERY-002` (reconciling `AVP-P02-001` & `AVP-P02-RECOVERY-001`)  
**Date:** `2026-11-22`  
**Evidence Sources:**
- `docs/phase-02/MODEL-DISCOVERY.md` (`sha256: 5c52407173452884da40e1e6fa0d0b102d11cf4b5fe826b59324aa64e5eb40d0`)
- `benchmarks/phase02/results-2026-11-20.json` (`sha256: 7abb940d90ae3df4176a66dac9280f105c3b7917541019f823e451ca7b866fe9`)
- `benchmarks/phase02/product-fit-results-2026-11-22.json` (`sha256: f75ff6a32f654c1cd8ed1eb4ce5274926dde6f7ab7bb51a42d40c9753a03648d`)
- `benchmarks/phase02/recovery-verification-2026-11-22.json` (`sha256: e8ebdb07764fb55c88d47d796bbdc7f4a1a9f26ed79263f7b8d6e6c7aae82b44`)
- `docs/AVAPARDAZ/PHASE-02-LICENSE-AUDIT.md` (`sha256: 827fac57ceb317f924d88e37a76c01d828ecef62117a33dd55fbffc70c1b5837`)
- `docs/AVAPARDAZ/MODEL-PROVENANCE.md` (`sha256: 8f29eaf76a42f8de2df2bea63568160e0a0942c18e2898767054e38f3e67c440`)

**Test Environment (`ACTUAL_LINUX_CPU_RESULTS`):** `Linux 4.19.0-gvisor x86_64`, `4 vCPU` (`AVX-512 VNNI / AVX2 / SSE4.2`), `12,288 MiB RAM`, `GPU: NONE`, `Python 3.11.2`, `FFmpeg 4.4.2`, `sherpa-onnx-offline v2.0.2` (`ONNX Runtime 1.28.2 CPU`).  
**Target Hardware (`ACTUAL_APPLE_M2_RESULTS`):** Apple Silicon M2 / 8 GB unified memory — **`NOT_RUN`** (`UNTESTED — PHYSICAL HARDWARE VALIDATION REQUIRED`).

---

## 1. Authoritative Candidate Inventory & Measured vs. Documented Matrix

Status tags follow strict epistemic separation: **`VERIFIED`**, **`MEASURED`**, **`DOCUMENTED`**, **`NOT_RUN`**, **`NOT_AVAILABLE`**, **`UNKNOWN`**, **`BLOCKED`**.

| Candidate ID | Exact Checkpoint & Revision | Runtime / Quantization | Disk (`MiB`) | FA Norm WER / CER | EN Norm WER | FA-EN Concat WER / CER | Word Timestamps | Linux CPU RTF / Peak RSS (`1x`) | Offline Status | License (`SPDX`) | Apple M2 (`8 GB`) | Eligibility Status |
| :--- | :--- | :--- | ---: | :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| **`C01`** `shenava-rizeh-v1-sherpa-int8` | `Reza2kn/Shenava-Rizeh` rev `14ca75f0c5c6` (`sherpa-onnx-nemo-ctc-fa-shenava-rizeh-v1.0-non-streaming-int8-2026-06-26`) | `sherpa-onnx v2.0.2` / INT8 ONNX | `36.43` `MEASURED` | **`19.44%` WER / `5.71%` CER** (Raw: `32.12%` / `7.58%`) `MEASURED` | `100.00%` (FA-only) `MEASURED` | `74.14%` WER / `65.23%` CER (`0.0%` Latin recall) `MEASURED` | **Native CTC token/word** `VERIFIED` | `RTF 0.0360` (25-clip), `0.0299–0.0315` (4T `wav_0`) / `165.81–204.5 MiB` `MEASURED` | `VERIFIED` (proxy-blackhole) | `Apache-2.0` `VERIFIED` | `NOT_RUN` | **PROVISIONAL PERSIAN SPECIALIST** (fails EN/CS) |
| **`C02`** `whisper-large-v3-turbo-sherpa-int8` | `openai/whisper-large-v3-turbo` rev `41f01f3fe87f` (`sherpa-onnx-whisper-turbo` INT8) | `sherpa-onnx v2.0.2` / INT8 ONNX | `988.59` `MEASURED` | **`27.78%` WER / `7.71%` CER** (Raw: `35.77%` / `8.71%`) `MEASURED` | **`5.83%`** (Raw: `10.86%`) `MEASURED` | `67.82%` WER / `63.90%` CER (`17.5%` Latin recall) `MEASURED` | **UNAVAILABLE (`SEGMENT`-only in `sherpa-onnx`)** `VERIFIED` | `RTF 0.6121` overall (`0.6976` `1x`) / `1,382.88 MiB` `MEASURED` | **PARTIAL (`offline_verified: false` in raw JSON; see note 1)** | `MIT` `VERIFIED` | `NOT_RUN` | **PROVISIONAL MULTILINGUAL COMPANION** (fails CS & native word timestamps) |
| **`C03`** `qwen3-asr-0.6b-sherpa-int8` | `Qwen/Qwen3-ASR-0.6B` rev `5eb144179a02` (INT8 ONNX) | `sherpa-onnx v2.0.2` / INT8 ONNX | `941.28` `MEASURED` | `74.31%` WER / `56.57%` CER (Raw: `75.18%` / `56.60%`) `MEASURED` | `13.00%` (Raw: `15.84%`) `MEASURED` | `56.90%` WER / `48.06%` CER (`72.01%` Latin recall) `MEASURED` | **UNAVAILABLE** (needs separate `Qwen3-ForcedAligner-0.6B`, Persian not in primary 11) `DOCUMENTED` | `RTF 0.9970` overall (`0.603` `1x`) / `1,588.21 MiB` `MEASURED` | `VERIFIED` (proxy-blackhole) | `Apache-2.0` `VERIFIED` | `NOT_RUN` | **REJECTED (ZERO-SHOT)** — Persian transliterated into Turkish/Latin |
| **`C04`** `whisper-base-sherpa-fp32` | `openai/whisper-base` (FP32 ONNX) | `sherpa-onnx v2.0.2` / FP32 ONNX | `278.90` `MEASURED` | `85.42%` WER / `29.57%` CER `MEASURED` | `12.56%` `MEASURED` | `90.23%` WER / `73.75%` CER (`5.0%` Latin recall) `MEASURED` | `SEGMENT`-only in `sherpa-onnx` | `RTF 0.2372` / `526.31 MiB` `MEASURED` | `VERIFIED` (proxy-blackhole) | `MIT` `VERIFIED` | `NOT_RUN` | **REJECTED** — Persian quality unacceptable |
| **`C05`** `whisper-base-sherpa-int8` | `openai/whisper-base` (INT8 ONNX) | `sherpa-onnx v2.0.2` / INT8 ONNX | `153.17` `MEASURED` | `103.47%` WER / `44.57%` CER (`+15.00 pp` quant regression!) `MEASURED` | `13.00%` `MEASURED` | `105.75%` WER / `78.52%` CER (`0.0%` Latin recall) `MEASURED` | `SEGMENT`-only in `sherpa-onnx` | `RTF 0.2314` / `326.68 MiB` `MEASURED` | `VERIFIED` (proxy-blackhole) | `MIT` `VERIFIED` | `NOT_RUN` | **REJECTED** — severe quantization regression |
| **`C06`** `dual-model-shenava-plus-whisper-turbo` | `C01` (`Reza2kn/Shenava-Rizeh` `14ca75f0c5c6`) + `C02` (`openai/whisper-large-v3-turbo` `41f01f3fe87f`) | `sherpa-onnx v2.0.2` (single binary, routed) | `1,025.02` combined `MEASURED` | `19.44%` WER / `5.71%` CER (via `C01`) `MEASURED` | `5.83%` WER (via `C02`) `MEASURED` | **NOT_RUN** (routed VAD/LID pipeline unbenchmarked) | Native CTC for FA (`C01`); **needs external aligner for EN (`C02`)** | `165.81 MiB` (FA only) / `1,382.88 MiB` (EN) / `~1.55 GiB` sequential, concurrent `NOT_RUN` | **PARTIAL** (inherits `C02` raw flag) | `Apache-2.0` + `MIT` `VERIFIED` | `NOT_RUN` | **LEADING ARCHITECTURAL CANDIDATE** — blocked pending routed CS benchmark, aligner, & M2 test |
| **`C07`** `whisper-large-v3-turbo-whispercpp-q5` | `openai/whisper-large-v3-turbo` rev `41f01f3fe87f` (GGML Q5_0) | `whisper.cpp` (C++/GGML) | `~547` `DOCUMENTED` | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` | Attention DTW (`-ml 1`, ±100–300ms jitter) `DOCUMENTED` | `NOT_RUN` | `NOT_RUN` | `MIT` `VERIFIED` | `NOT_RUN` | **CANDIDATE FOR FOLLOW-UP** (alternative multilingual runtime with DTW word timestamps) |
| **`C08`** `nvidia-stt-fa-fastconformer-hybrid-large` | `nvidia/stt_fa_fastconformer_hybrid_large` rev `249cf5bf70dd` | NeMo -> ONNX export | `NOT_AVAILABLE` | Upstream `13.16%` CV-fa `DOCUMENTED`; local `NOT_RUN` | Unsupported (FA-only) `DOCUMENTED` | Unsupported (FA-only) `DOCUMENTED` | Native CTC/RNN-T `DOCUMENTED` | `NOT_RUN` | `NOT_RUN` | `CC-BY-4.0` `VERIFIED` | `NOT_RUN` | **SECONDARY PERSIAN CANDIDATE** (larger 114M teacher; unbenchmarked locally) |
| **`C09`** `vhdm-whisper-large-fa-v1` | `vhdm/whisper-large-fa-v1` rev `954853914069` | Fine-tuned Whisper Turbo (needs ONNX/GGML export) | `NOT_AVAILABLE` | `NOT_RUN` | `UNKNOWN` (EN forgetting risk) | `NOT_RUN` | Inherits Whisper DTW/aligner `DOCUMENTED` | `NOT_RUN` | `NOT_RUN` | `MIT` `VERIFIED` | `NOT_RUN` | **DEFERRED** (needs ONNX/GGML conversion + EN regression test) |
| **`C10`** `qwen3-asr-1.7b` | `Qwen/Qwen3-ASR-1.7B` rev `7278e1e70fe2` | `QwenLM/Qwen3-ASR` / ONNX INT8 | `~2,000–2,500` `DOCUMENTED` | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` | Needs `Qwen3-ForcedAligner-0.6B` `DOCUMENTED` | `NOT_RUN` | `NOT_RUN` | `Apache-2.0` `VERIFIED` | `NOT_RUN` | **DEFERRED** (heavy RAM/CPU risk for 8 GB target) |
| **`C11`** `nvidia-parakeet-tdt-0.6b-v2-v3` | `nvidia/parakeet-tdt-0.6b-v2` / `v3` | `sherpa-onnx` / NeMo | `NOT_AVAILABLE` | **UNSUPPORTED (0% Persian)** `DOCUMENTED` | SOTA `DOCUMENTED` | Unsupported `DOCUMENTED` | Native TDT `DOCUMENTED` | `NOT_RUN` | `NOT_RUN` | `CC-BY-4.0` `VERIFIED` | `NOT_RUN` | **DISQUALIFIED AS PERSIAN BASE** (no Persian) |
| **`C12`** `sensevoice-small` / `moonshine` | `FunAudioLLM/SenseVoiceSmall` / `UsefulSensors/Moonshine` | ONNX | `NOT_AVAILABLE` | **UNSUPPORTED (0% Persian)** `DOCUMENTED` | `DOCUMENTED` | Unsupported `DOCUMENTED` | `DOCUMENTED` | `NOT_RUN` | `NOT_RUN` | FunASR v1.1 / `MIT` `DOCUMENTED` | `NOT_RUN` | **DISQUALIFIED** (no Persian) |
| **`C13`** `facebook-mms-1b` / `seamless-m4t-v2` | `facebook/mms-1b-all` (`3d33597edbda`) / `facebook/seamless-m4t-v2-large` (`5f8cc790b19f`) | PyTorch / ONNX | `NOT_AVAILABLE` | `NOT_RUN` | `NOT_RUN` | `NOT_RUN` | CTC (`mms`) `DOCUMENTED` | `NOT_RUN` | `NOT_RUN` | **`CC-BY-NC-4.0` (INCOMPATIBLE)** `VERIFIED` | `NOT_RUN` | **LEGALLY DISQUALIFIED** (non-commercial) |
| **`C14`** `hezarai-whisper-small-fa` / `vosk-fa-0.42` | `hezarai/whisper-small-fa` (`17111ae71a06`) / `vosk-model-small-fa-0.42` | Whisper / Kaldi FST | `~50` (Vosk) `DOCUMENTED` | `NOT_RUN` | Unsupported (Vosk) | Fails (static FST) `DOCUMENTED` | Kaldi word (`vosk`) | `NOT_RUN` | `NOT_RUN` | `hezarai`: **`UNKNOWN`**; `vosk`: `Apache-2.0` | `NOT_RUN` | **BLOCKED / DISQUALIFIED** (`hezarai` missing license; `vosk` static FST fails EN/CS/OOV) |

> **Forensic Note 1 (`C02` Offline Flag Discrepancy):** In `benchmarks/phase02/results-2026-11-20.json`, `openai/whisper-large-v3-turbo-int8` records `"offline_verified": false` alongside a `recovery_note` stating 10 failed UTF-8 split-byte samples were re-run under the identical proxy-blackhole env (`rc=0` on `25/25`), and its `subsets.en.total_inference_sec` / `rtf` fields are `0.0`. Older `docs/AVAPARDAZ/MODEL-SELECTION-REPORT.md` simplified this to `Offline: PASS`. Under `AVP-P02-RECOVERY-002` strict honesty rules, `C02` offline verification is recorded as **`PARTIAL`** until a clean single-pass `25/25` offline run records `"offline_verified": true`.

---

## 2. Exact On-Disk Artifact Hashes (Benchmarked Models)

Source: `benchmarks/phase02/results-2026-11-20.json` & direct filesystem SHA-256 verification on `2026-11-22` (for currently installed `C01`).

| Candidate ID | Artifact File | Exact Bytes | `SHA-256` Digest | Present on Disk (`2026-11-22`) |
| :--- | :--- | ---: | :--- | :---: |
| `C01` `Reza2kn/Shenava-Rizeh` | `model.int8.onnx` | `38,183,269` | `6bdd4ab80626ddfe0b19338a5c96fcc4f2021ad78899cece20a805a48dc5250d` | **YES** (`/root/.avapardaz/models/...`) |
| `C01` `Reza2kn/Shenava-Rizeh` | `tokens.txt` | `12,236` | `8e192963f6e666dfa5721e5cbd4710bc1ef592460a45f08cefc94b2db16a6954` | **YES** (`/root/.avapardaz/models/...`) |
| `C02` `openai/whisper-large-v3-turbo-int8` | `turbo-encoder.int8.onnx` | `674,716,297` | `b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b` | NO (was in `/tmp/avp-p02-bench/`) |
| `C02` `openai/whisper-large-v3-turbo-int8` | `turbo-decoder.int8.onnx` | `361,080,764` | `20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547` | NO (was in `/tmp/avp-p02-bench/`) |
| `C02` `openai/whisper-large-v3-turbo-int8` | `turbo-tokens.txt` | `816,730` | `b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126` | NO (was in `/tmp/avp-p02-bench/`) |
| `C03` `Qwen/Qwen3-ASR-0.6B-int8` | `conv_frontend.onnx` | `44,148,281` | `d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e` | NO |
| `C03` `Qwen/Qwen3-ASR-0.6B-int8` | `encoder.int8.onnx` | `182,491,662` | `60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9` | NO |
| `C03` `Qwen/Qwen3-ASR-0.6B-int8` | `decoder.int8.onnx` | `755,914,231` | `4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771` | NO |
| `C04` `openai/whisper-base-fp32` | `base-encoder.onnx` | `95,087,154` | `5a6b87cb313993f6c9fefec9e7027556f6cb30becddf49655bee36c50ecc12d7` | NO |
| `C04` `openai/whisper-base-fp32` | `base-decoder.onnx` | `196,548,998` | `8a12c3f6ad65bb5b86d7e6eccc302378f20f9fb2df6cb10747c62895da7ac194` | NO |
| `C05` `openai/whisper-base-int8` | `base-encoder.int8.onnx` | `29,120,534` | `0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11` | NO |
| `C05` `openai/whisper-base-int8` | `base-decoder.int8.onnx` | `130,672,026` | `9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d` | NO |

---

## 3. Known Limitations & Unverified Assumptions

1. **No Single Evaluated Model Passes All Product Criteria:** `C01` fails English and Code-Switching; `C02` fails Code-Switching and lacks native word-level timestamps in `sherpa-onnx`; `C03` fails zero-shot Persian.
2. **Legacy Footprint Discrepancy Reconciled:** Older docs (`docs/AVAPARDAZ/PHASE-02-LICENSE-AUDIT.md` & `PHASE-02-RUNTIME-COMPATIBILITY.md`) cited compressed archive sizes (`~29.6 MB`, `~538 MB`, `~838 MB`) rather than unpacked on-disk artifact sizes (`36.43 MiB`, `988.59 MiB`, `941.28 MiB`). All Phase-02 Revision 2 reports standardize on exact unpacked byte counts.
3. **Unbenchmarked Contenders (`C07`, `C08`, `C09`, `C10`):** Recorded as `NOT_RUN` — never treated as verified performance.
4. **Acceptance Status of This Deliverable:** `COMPLETE` (Matrix accurately reconciles all discovered candidates; overall Phase-02 status remains `BLOCKED` — see `docs/phase-02/PHASE-02-ACCEPTANCE.md`).
