# AVAPARDAZ — MODEL REGISTRY (v3.2 — POST PHASE-02 / PHASE-15)

**Document ID:** `AVP-MODEL-REGISTRY-3.2`  
**Supersedes:** `AVP-MODEL-REGISTRY-3.0` (`PHASE-00`)  
**Last Updated:** `2026-11-20` (`PHASE-02` Accepted + `PHASE-08..15` Verified)  
**Policy:** Every candidate is tracked across **8 independent lifecycle states** (`MANIFEST_EXISTS`, `WEIGHTS_EXIST`, `LICENSE_VERIFIED`, `HASH_VERIFIED`, `RUNTIME_AVAILABLE`, `MODEL_LOADED`, `REAL_INFERENCE_EXECUTED`, `TRANSCRIPTION_VERIFIED`). Model weights are **never committed to Git** (`ADR-006`); verified weights reside in external local model packs / `/tmp/avp-p02-bench/models/` during container validation.

---

## 1. Repository Weight Hygiene Check (`[OBSERVED — 2026-11-20]`)

- **Binary weights committed inside `/app/applet` repo:** **`0` files** (`find . -maxdepth 4 \( -name "*.onnx" -o -name "*.wav" \) ! -path "./node_modules/*"` -> empty).
- **Verified external local neural models benchmarked & executed offline (`sherpa-onnx v2.0.2`):** **`5` real ONNX checkpoints** (`results-2026-11-20.json`).

---

## 2. Assigned Product Model Profiles (`ADR-023` — Evidence-Backed)

| Profile ID | Target Hardware Tiers | Assigned Native Model (Companion) | Assigned Browser Model (`onnxruntime-web`) | Verified Metrics (`25` FLEURS `dev` WAVs) | Status |
| :--- | :--- | :--- | :--- | :--- | :---: |
| **`AVP_MODEL_LITE`** | `TIER-0..3` (`4–8 GB+` RAM / Persian Fast / Browser) | **`Reza2kn/Shenava-Rizeh v1.0`** *(NeMo FastConformer CTC INT8, `36.43 MiB`, `Apache-2.0`)* | **`Reza2kn/Shenava-Rizeh v1.0`** *(INT8 ONNX, fits `384 MiB` mobile WASM limit)* | FA Norm CER **`5.71%`**, `RTF 0.036` (`27.8×` RT), RSS `165.8 MiB`, Native Word Timestamps | **`SELECTED & VERIFIED (NATIVE)`** |
| **`AVP_MODEL_BALANCED`** | `TIER-1..2` (`8–16 GB` RAM / Mainstream Desktop) | **Hybrid Language-Routed:** `Shenava-Rizeh` (`fa`) + `Whisper large-v3-turbo INT8` (`en`/`auto`) | `Shenava-Rizeh` (`fa`); English/Multilingual requires Native Companion or `TIER-2` desktop browser | FA **`5.71%`** CER / EN **`5.83%`** WER | **`SELECTED & VERIFIED (NATIVE)`** |
| **`AVP_MODEL_QUALITY`** | `TIER-2..3` (`16+ GB` RAM / Capable CPU) | **`openai/whisper-large-v3-turbo-int8`** *(`988.59 MiB`, `MIT`)* — upgrade path: GPU-fine-tuned bilingual (`PHASE-06`) | Native Companion Recommended (too heavy for `TIER-0`/`1` WASM32 tabs) | FA Norm CER **`7.71%`**, EN Norm WER **`5.83%`**, `RTF 0.612` (`1.63×` RT), RSS `1,382.9 MiB` | **`SELECTED & VERIFIED (NATIVE)`** |

---

## 3. Benchmarked Open-Source Candidate Models (8-State Matrix)

| Candidate ID | Model Checkpoint & License | `MANIFEST_EXISTS` | `WEIGHTS_EXIST` *(Local Pack)* | `LICENSE_VERIFIED` | `HASH_VERIFIED` | `RUNTIME_AVAILABLE` | `MODEL_LOADED` | `REAL_INFERENCE_EXECUTED` | `TRANSCRIPTION_VERIFIED` | Decision |
| :--- | :--- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :--- |
| `CAND-SHENAVA` | `Reza2kn/Shenava-Rizeh v1.0` (NeMo FastConformer CTC INT8, `Apache-2.0`, `36.43 MiB`) | YES | YES | YES | YES | YES (`sherpa-onnx`) | YES | YES (`25/25` + Live HTTP Companion) | YES (`5.71%` FA CER) | **`SELECTED (AVP_MODEL_LITE / FA)`** |
| `CAND-WHISPER-TURBO` | `openai/whisper-large-v3-turbo-int8` (`MIT`, `988.59 MiB`) | YES | YES | YES | YES | YES (`sherpa-onnx`) | YES | YES (`25/25`) | YES (`7.71%` FA CER, `5.83%` EN WER) | **`SELECTED (AVP_MODEL_QUALITY / EN)`** |
| `CAND-WHISPER-BASE-FP32` | `openai/whisper-base-fp32` (`MIT`, `278.90 MiB`) | YES | YES | YES | YES | YES (`sherpa-onnx`) | YES | YES (`25/25`) | YES (`29.57%` FA CER, `12.56%` EN WER) | `BASELINE_ONLY` (Superseded by Turbo + Shenava) |
| `CAND-WHISPER-BASE-INT8` | `openai/whisper-base-int8` (`MIT`, `153.17 MiB`) | YES | YES | YES | YES | YES (`sherpa-onnx`) | YES | YES (`25/25`) | YES (`44.57%` FA CER — `+15.0 pp` regression!) | **`REJECTED` (`ADR-024`)** |
| `CAND-QWEN3-0.6B` | `Qwen/Qwen3-ASR-0.6B-int8` (`Apache-2.0`, `941.28 MiB`) | YES | YES | YES | YES | YES (`sherpa-onnx`) | YES | YES (`25/25`) | YES (`56.57%` FA CER — Latin/Turkish translit.) | **`REJECTED ZERO-SHOT`** (Re-test ONLY after GPU Persian fine-tuning) |
| `CAND-VOSK-FA` | `Vosk` (`vosk-model-small-fa-0.42`, `Apache-2.0`) | YES | NO | YES | NO | NO | NO | NO | NO | `DISQUALIFIED` (Fixed monolingual Kaldi FST; superseded by `Shenava-Rizeh`) |

---

## 4. Legacy Non-Neural / Decommissioned Entries

| Identifier | File | Status |
| :--- | :--- | :--- |
| `LOCAL_CPU_ACOUSTIC_CTC_ADAPTER` (`CoreAcousticCtcEngine`) | `src/asr-core/CoreAcousticCtcEngine.ts` | Retained strictly as deterministic unit-test fixture; **NOT** used as production neural ASR. |
| `gemini-3.5-transcribe` (`/api/v1/asr/transcribe`) | `server.ts` | **DECOMMISSIONED** (`HTTP 410 Gone` enforced; `@google/genai` removed). |
