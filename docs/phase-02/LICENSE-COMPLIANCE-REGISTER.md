# AVAPARDAZ — PHASE-02: LICENSE & COMMERCIAL COMPLIANCE REGISTER

**Document ID:** `AVP-P02-LICENSE-2.0`  
**Execution ID:** `AVP-P02-RECOVERY-002`  
**Audit Date:** `2026-11-22` (reconciled against direct Hugging Face API / upstream repo audit dated `2026-11-20`)  
**Evidence Sources:**
- `docs/AVAPARDAZ/PHASE-02-LICENSE-AUDIT.md` (`sha256: 827fac57ceb317f924d88e37a76c01d828ecef62117a33dd55fbffc70c1b5837`)
- `docs/AVAPARDAZ/MODEL-PROVENANCE.md` (`sha256: 8f29eaf76a42f8de2df2bea63568160e0a0942c18e2898767054e38f3e67c440`)
- `benchmarks/phase02/results-2026-11-20.json` (`sha256: 7abb940d90ae3df4176a66dac9280f105c3b7917541019f823e451ca7b866fe9`)
- `/root/.avapardaz/models/sherpa-onnx-nemo-ctc-fa-shenava-rizeh-v1.0-non-streaming-int8-2026-06-26/README.md` (`sha256: 4a0adc1386eb21e4f2cc2ae35cfabf58d17b10d1403b604bc1986cf08a9f1748`)
- `package.json` (runtime dependencies verification)

**Classification Taxonomy:**
- `VERIFIED_PERMISSIVE`: Commercial use and redistribution allowed with standard copyright/NOTICE inclusion (`MIT`, `Apache-2.0`).
- `VERIFIED_CONDITIONAL`: Commercial use permitted subject to explicit attribution or license-specific obligations (`CC-BY-4.0`, `LGPL`, `FunASR v1.1`).
- `UNKNOWN`: License metadata missing, undeclared, or unverified (`COMMERCIAL_ELIGIBILITY = NOT_VERIFIED`; legally blocked).
- `INCOMPATIBLE`: Explicitly prohibits commercial use (`CC-BY-NC-4.0`) or imposes incompatible copyleft restrictions.

---

## 1. Model Source Code, Pretrained Weights & Tokenizer License Register

Every model separates **Source/Architecture Code**, **Pretrained Weights**, and **Tokenizer/Conversion Export** because upstream code and weights do not always share the same license.

| Model / Checkpoint | Exact Revision (`SHA`) | Source Code License | Pretrained Weight License | Tokenizer / Export License | Commercial Product Use | Redistribution Allowed | Classification | Audit Notes & Obligations |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **`Reza2kn/Shenava-Rizeh v1.0`** (`sherpa-onnx-nemo-ctc-fa-shenava-rizeh-v1.0-non-streaming-int8-2026-06-26`) | `14ca75f0c5c6` | `Apache-2.0` (NeMo / `sherpa-onnx`) | **`Apache-2.0`** `VERIFIED` | `Apache-2.0` (`tokens.txt`, `convert.py`) | **YES** | **YES** | **`VERIFIED_PERMISSIVE`** | Must ship `LICENSE` & `NOTICE` files with model pack; zero weights in Git (`ADR-006`). |
| **`openai/whisper-large-v3-turbo`** (+ `sherpa-onnx-whisper-turbo` INT8) | `41f01f3fe87f` | `MIT` (OpenAI) / `Apache-2.0` (`sherpa-onnx`) | **`MIT`** `VERIFIED` | `MIT` (`turbo-tokens.txt`) | **YES** | **YES** | **`VERIFIED_PERMISSIVE`** | Retain OpenAI MIT copyright notice + `sherpa-onnx` Apache-2.0 notice. |
| **`openai/whisper-base`** (FP32 & INT8) | `5359861c739e` | `MIT` | **`MIT`** `VERIFIED` | `MIT` | **YES** | **YES** | **`VERIFIED_PERMISSIVE`** | Legally eligible; **technically rejected** on Persian CER/WER. |
| **`Qwen/Qwen3-ASR-0.6B`** (+ INT8 ONNX export) | `5eb144179a02` | `Apache-2.0` (`QwenLM/Qwen3-ASR`) | **`Apache-2.0`** `VERIFIED` | `Apache-2.0` (`vocab.json`, `merges.txt`) | **YES** | **YES** | **`VERIFIED_PERMISSIVE`** | Legally eligible; **technically rejected** for zero-shot Persian (`56.57%` CER). |
| **`Qwen/Qwen3-ASR-1.7B`** | `7278e1e70fe2` | `Apache-2.0` | **`Apache-2.0`** `VERIFIED` | `Apache-2.0` | **YES** | **YES** | **`VERIFIED_PERMISSIVE`** | Legally eligible; unbenchmarked on target CPU (`NOT_RUN`). |
| **`nvidia/stt_fa_fastconformer_hybrid_large`** | `249cf5bf70dd` | `Apache-2.0` (NeMo) | **`CC-BY-4.0`** `VERIFIED` | `CC-BY-4.0` | **YES** (w/ attribution) | **YES** (w/ attribution) | **`VERIFIED_CONDITIONAL`** | Requires clear NVIDIA `CC-BY-4.0` attribution and indication if modified. |
| **`nvidia/parakeet-tdt-0.6b-v2` / `v3`** | Upstream HF | `Apache-2.0` (NeMo) | **`CC-BY-4.0`** `DOCUMENTED` | `CC-BY-4.0` | **YES** (w/ attribution) | **YES** (w/ attribution) | **`VERIFIED_CONDITIONAL`** | Disqualified technically (no Persian support). |
| **`vhdm/whisper-large-fa-v1`** | `954853914069` | `MIT` | **`MIT`** `VERIFIED` | `MIT` | **YES** | **YES** | **`VERIFIED_PERMISSIVE`** | Training dataset provenance of community fine-tune requires secondary legal check before commercial shipping. |
| **`alphacep/vosk-model-small-fa-0.42`** | `v0.42` | `Apache-2.0` | `Apache-2.0` `DOCUMENTED` | `Apache-2.0` | **YES** | **YES** | **`VERIFIED_PERMISSIVE`** | Technically disqualified (static FST fails EN/CS/OOV). |
| **`FunAudioLLM/SenseVoiceSmall`** | Upstream HF | `MIT` (FunASR) | FunASR Model License v1.1 `DOCUMENTED` | FunASR v1.1 | **YES** (w/ attribution) | Conditional | **`VERIFIED_CONDITIONAL`** | Technically disqualified (no Persian support). |
| **`hezarai/whisper-small-fa`** | `17111ae71a06` | `MIT` (Whisper base) | **`UNKNOWN`** (`license=[]` in HF API) | **`UNKNOWN`** | **NOT_VERIFIED** | **NOT_VERIFIED** | **`UNKNOWN`** | **BLOCKED:** Missing explicit SPDX license on weights; prohibited from selection. |
| **`facebook/mms-1b-all`** | `3d33597edbda` | `MIT` (fairseq) | **`CC-BY-NC-4.0`** `VERIFIED` | `CC-BY-NC-4.0` | **NO** | **NO (Commercial)** | **`INCOMPATIBLE`** | **REJECTED:** Non-commercial weight license strictly prohibits AVAPARDAZ commercial distribution. |
| **`facebook/seamless-m4t-v2-large`** | `5f8cc790b19f` | `MIT` | **`CC-BY-NC-4.0`** `VERIFIED` | `CC-BY-NC-4.0` | **NO** | **NO (Commercial)** | **`INCOMPATIBLE`** | **REJECTED:** Non-commercial weight license strictly prohibits commercial distribution. |

---

## 2. Inference Runtime, Audio Decoder & Toolchain License Register

| Component | Version Observed | Upstream Source | License (`SPDX`) | Classification | Commercial Packaging & Compliance Notes |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **`k2-fsa/sherpa-onnx`** | `v2.0.2` (`ONNX Runtime 1.28.2 CPU`) | `https://github.com/k2-fsa/sherpa-onnx` | `Apache-2.0` (`ORT`: `MIT`) | **`VERIFIED_PERMISSIVE`** | Single native binary verified on Linux x86_64; macOS ARM64 (`M2`) binary exists upstream (`NOT_RUN` locally). |
| **`onnxruntime-web`** | `^1.31.1` (in `package.json`) | `https://github.com/microsoft/onnxruntime` | `MIT` | **`VERIFIED_PERMISSIVE`** | 4 `.wasm` binaries verified via SHA-256 in `MODEL-PROVENANCE.md`. |
| **`whisper.cpp`** | Upstream (not installed locally) | `https://github.com/ggml-org/whisper.cpp` | `MIT` | **`VERIFIED_PERMISSIVE`** | Candidate alternative runtime for Whisper DTW word timestamps; `NOT_RUN` locally. |
| **`faster-whisper` / CTranslate2** | Upstream (not installed locally) | `https://github.com/SYSTRAN/faster-whisper` | `MIT` | **`VERIFIED_PERMISSIVE`** | Requires Python + CTranslate2 bundling; higher desktop packaging friction for Audition plugin. |
| **`FFmpeg` (System Decoder)** | `4.4.2-0ubuntu0.22.04.1+esm17` | `https://ffmpeg.org/` | **`LGPL-2.1+` / `GPL-2.0+`** (build-flag dependent!) | **`VERIFIED_CONDITIONAL`** | **CRITICAL PACKAGING NOTE:** System Ubuntu FFmpeg builds often include `--enable-gpl` codecs (`libx264`, etc.). Any future Phase-03/04 desktop installer MUST either link a strictly `--disable-gpl --disable-nonfree` LGPL build (dynamically linked) or use permissive native decoders (CoreAudio on macOS, `symphonia`/`minimp3`/`dr_libs`). |

---

## 3. Evaluation Dataset License Register

| Dataset | Split Used | License (`SPDX`) | Classification | Commercial / Evaluation Restriction |
| :--- | :--- | :---: | :---: | :--- |
| **`google/fleurs`** (`fa_ir`, `en_us`) | `dev` ONLY (`25` clips, `277.33s`) | `CC-BY-4.0` | **`VERIFIED_CONDITIONAL`** | Evaluation only; attribution required (Conneau et al., 2022). Never committed to Git. `test` split untouched. |
| **Bundled `Shenava-Rizeh` `test_wavs/`** | `0.wav` (`14.466s`), `1.wav` (`2.536s`) | `Apache-2.0` (bundled w/ model release) | **`VERIFIED_PERMISSIVE`** | Used for offline smoke, timestamp offset, repetition & stability probes; provenance of underlying speakers is `UNKNOWN` (upstream model release samples). |
| **`training/data/*.jsonl`** | Placeholder metadata only (`0` audio files) | Declared `CC-BY-4.0` in JSON text | **`UNKNOWN`** | **NOT REAL DATA:** Contains synthetic placeholder SHA-256 strings (`a1b2c3d4e5f60001`, etc.) and zero backing audio files. Excluded from all Phase-02 claims. |

---

## 4. Known Limitations & Unverified Assumptions

1. **Upstream Training-Data Indemnity:** Permissive weight licenses (`Apache-2.0`, `MIT`) grant permission from the model publisher, but AVAPARDAZ has not independently audited the legal provenance of every upstream pretraining corpus inside OpenAI Whisper or community fine-tunes (`vhdm/whisper-large-fa-v1`).
2. **FFmpeg Build-Time License Verification:** Current Linux host uses OS-packaged `ffmpeg 4.4.2` for benchmark preparation only; commercial redistribution requires an audited LGPL-only build or OS-native decoders (e.g., Apple CoreAudio on macOS).
3. **Compliance Verdict for `P02-03`:** **`PASS`** for all evaluated Phase-02 model candidates and runtimes (`Reza2kn/Shenava-Rizeh` `Apache-2.0`, `openai/whisper-large-v3-turbo` `MIT`, `sherpa-onnx` `Apache-2.0`, `onnxruntime-web` `MIT`, `google/fleurs` `CC-BY-4.0`; `CC-BY-NC-4.0` and `UNKNOWN` models formally excluded).
