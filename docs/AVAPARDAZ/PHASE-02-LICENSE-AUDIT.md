# AVAPARDAZ — PHASE-02 OPEN-SOURCE ASR LICENSE & COMMERCIAL DISTRIBUTION AUDIT (`AVP-P02-001`)

**Document ID:** `AVP-P02-LICENSE-001`  
**Phase:** `PHASE-02` — Open-Source Model Discovery & Multi-Device CPU Benchmark (`MASTER v3.1`)  
**Date:** `2026-11-20`  
**Verification Method:** Direct live query against Hugging Face Model API (`huggingface.co/api/models/*`), official GitHub repositories, and `k2-fsa/sherpa-onnx` release manifests (`[OBSERVED]`).

---

## 1. Commercial Eligibility & Redistribution Matrix

| Candidate Model / Runtime | Upstream Repository / HF ID | Verified Live Revision (`SHA`) | Verified License (`SPDX`) | Commercial Product Use | Weight Redistribution Permitted | Runtime / Deployment Notes | Decision |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- | :---: |
| **`Qwen3-ASR-0.6B`** (+ ONNX INT8 export) | `Qwen/Qwen3-ASR-0.6B` / `QwenLM/Qwen3-ASR` / `k2-fsa/sherpa-onnx` | `5eb144179a02` | `Apache-2.0` | **YES** | **YES** (with NOTICE/license) | Native CPU (`sherpa-onnx` INT8, GGUF); Web WASM feasible only for INT4/split graphs (`~838 MB` INT8 exceeds safe low-RAM browser tab budget) | **`APPROVED_CANDIDATE`** |
| **`Qwen3-ASR-1.7B`** & **`1.7B-hf`** | `Qwen/Qwen3-ASR-1.7B`, `Qwen/Qwen3-ASR-1.7B-hf` | `7278e1e70fe2` / `bcd2b5b7f32b` | `Apache-2.0` | **YES** | **YES** | Workstation (`TIER-2`/`TIER-3`) Native CPU (`~2.0–2.5 GiB` INT8 RAM); unsuitable for browser WASM32 | **`APPROVED_CANDIDATE`** |
| **`OpenAI Whisper large-v3-turbo`** | `openai/whisper-large-v3-turbo` / `sherpa-onnx-whisper-turbo` | `41f01f3fe87f` | `MIT` | **YES** | **YES** | Native CPU (`whisper.cpp` GGML Q4/Q5/Q8, `faster-whisper` CT2, `sherpa-onnx` INT8 `538 MB`); Browser WASM heavy (`TIER-2+` only) | **`APPROVED_CANDIDATE`** |
| **`OpenAI Whisper base` / `small`** | `openai/whisper-small` / `ggerganov/whisper.cpp` | `973afd24965f` / `5359861c739e` | `MIT` / `Apache-2.0` | **YES** | **YES** | Native CPU (`whisper.cpp`, `sherpa-onnx`) + **Browser WASM (`onnxruntime-web` / `whisper.wasm`) directly feasible** (`198 MB` base INT8) | **`APPROVED_CANDIDATE`** |
| **`NVIDIA NeMo FastConformer CTC Persian (Shenava Rizeh v1.0 / 115M)`** | `Reza2kn/Shenava-Rizeh`, `Reza2kn/shenava-fa-fastconformer-115m`, `sherpa-onnx` | `14ca75f0c5c6` / `5c4380e9e8c6` | `Apache-2.0` | **YES** | **YES** | Ultra-compact (`29.6 MB` INT8 ONNX!), sub-0.1 RTF on CPU, **ideal for Browser WASM & `TIER-0`**, **Persian-only** (no English/code-switching) | **`APPROVED_SPECIALIST_FA_ONLY`** |
| **`NVIDIA stt_fa_fastconformer_hybrid_large`** | `nvidia/stt_fa_fastconformer_hybrid_large` | `249cf5bf70dd` | `CC-BY-4.0` | **YES** (attribution required) | **YES** (attribution required) | 114M Persian-only hybrid FastConformer; requires NeMo->ONNX export | **`APPROVED_WITH_ATTRIBUTION`** |
| **`vhdm/whisper-large-fa-v1`** | `vhdm/whisper-large-fa-v1` | `954853914069` | `MIT` | **YES** | **YES** | Persian fine-tune of `whisper-large-v3-turbo`; requires GGML/ONNX conversion & English regression check before promotion | **`APPROVED_CANDIDATE`** |
| **`Vosk` (`vosk-model-small-fa-0.42`)** | `alphacep/vosk-api` / `alphacephei.com/vosk` | `v0.42` | `Apache-2.0` | **YES** | **YES** | ~50 MB Kaldi FST graph; **fixed Persian-only vocabulary (`HCLG.fst`) fails English & Persian-English code-switching** | **`DISQUALIFIED_AS_PRIMARY`** (no bilingual code-switch) |
| **`hezarai/whisper-small-fa`** | `hezarai/whisper-small-fa` | `17111ae71a06` | `UNDECLARED` (`license=[]` in HF API) | **HOLD** | **HOLD** | Missing explicit SPDX license metadata in HF card despite MIT Whisper base | **`BLOCKED_PENDING_LICENSE_CLARIFICATION`** |
| **`facebook/mms-1b-all`** | `facebook/mms-1b-all` | `3d33597edbda` | **`CC-BY-NC-4.0`** | **NO** | **NO (Non-Commercial)** | Explicitly prohibits commercial product deployment | **`REJECTED_NON_COMMERCIAL`** |
| **`facebook/seamless-m4t-v2-large`** | `facebook/seamless-m4t-v2-large` | `5f8cc790b19f` | **`CC-BY-NC-4.0`** | **NO** | **NO (Non-Commercial)** | Explicitly prohibits commercial product deployment | **`REJECTED_NON_COMMERCIAL`** |

---

## 2. Inference Runtime Licenses (Verified)

| Runtime | Upstream Repo | License (`SPDX`) | Platform Target | Commercial Verdict |
| :--- | :--- | :---: | :--- | :---: |
| **`sherpa-onnx` (`v2.0.2`)** | `https://github.com/k2-fsa/sherpa-onnx` | `Apache-2.0` | Native CPU (Windows/macOS/Linux `x86_64`/`ARM64`) + WASM | **APPROVED** |
| **`onnxruntime-web` (`^1.31.1`)** | `https://github.com/microsoft/onnxruntime` | `MIT` | Browser Web Worker WASM CPU / SIMD | **APPROVED** (already installed in `package.json`) |
| **`whisper.cpp`** | `https://github.com/ggml-org/whisper.cpp` | `MIT` | Native CPU (`SSE4.2`/`AVX2`/`NEON`) + WASM | **APPROVED** |
| **`faster-whisper` / CTranslate2** | `https://github.com/SYSTRAN/faster-whisper` | `MIT` | Native Python/C++ CPU (`INT8`) | **APPROVED** (requires Python/CT2 packaging) |

---

## 3. Evaluation Dataset License & Hygiene Audit (`PHASE-02` Bake-off)

- **Evaluation Audio Used in `PHASE-02`:** `google/fleurs` (`fa_ir` and `en_us`, **`dev` split ONLY**) — License: **`CC-BY-4.0`** (attribution preserved: Conneau et al., 2022, Google FLEURS).
- **Frozen Test Set Protection:** Neither `google/fleurs` `test` split nor `ArmanJR/PESTE-Benchmark` (`871` test clips) was touched during `PHASE-02` model discovery, preserving `100%` Frozen Test hygiene for downstream `PHASE-06`/`07`.
- **Distribution Cost:** `$0` per-minute / `$0` API licensing cost for all `APPROVED_CANDIDATE` models and runtimes (100% offline local CPU execution).
