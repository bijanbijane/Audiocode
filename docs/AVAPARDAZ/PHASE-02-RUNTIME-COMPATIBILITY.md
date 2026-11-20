# AVAPARDAZ — PHASE-02 NATIVE CPU (ADOBE AUDITION) VS BROWSER ONNX/WASM COMPATIBILITY (`AVP-P02-001`)

**Document ID:** `AVP-P02-RUNTIME-001`  
**Phase:** `PHASE-02` — Open-Source Model Discovery & Multi-Device CPU Benchmark (`MASTER v3.1`)  
**Date:** `2026-11-20`  
**Architecture Authority:** Single Central `AVAPARDAZ ASR CORE` (`ADR-001` / `ADR-002` / `ADR-005`) serving:
1. **Product A (`P1` Primary):** Adobe Audition CEP Panel + Standalone Native CPU Companion (`127.0.0.1` HMAC IPC)
2. **Product B (`P2` Secondary):** Web Application Client (`Web Worker` + `onnxruntime-web@1.31.1` WASM CPU + OPFS — zero Companion dependency)

---

## 1. Platform-Specific Execution Realities (`[OBSERVED]`)

| Dimension | Native CPU Companion (Adobe Audition `P1`) | Browser ONNX/WASM Worker (Web App `P2`) |
| :--- | :--- | :--- |
| **Address Space Ceiling** | Full 64-bit virtual memory (`4–64+ GB` host RAM) | 32-bit WebAssembly (`wasm32`) hard limit (`2–4 GiB` theoretical; practical safe tab ceiling `512 MiB – 1,024 MiB`, `<= 384 MiB` iOS Safari) |
| **CPU Vectorization** | Native x86_64 `SSE4.2` / `AVX2` / `AVX-512 VNNI` & ARM64 `NEON` | WASM 128-bit SIMD (`WebAssembly.validate()` probed via `CrossPlatformResourcePolicy.ts`); optional `pthreads` only when `crossOriginIsolated === true` |
| **Runtime Binary Verified** | `sherpa-onnx` `v2.0.2` (`Apache-2.0`, `26.0 MB` shared Linux x64 build verified live on container) + `whisper.cpp` (`MIT`) | `onnxruntime-web@^1.31.1` (`MIT`, `15 MB` `ort-wasm-simd-threaded.wasm` verified in `node_modules/onnxruntime-web/dist/`; `/public/ort/` provisioning scheduled in `PHASE-05`) |
| **Offline Weight Storage** | Local OS model directory with SHA-256 verification | Chunked OPFS (`storageBroker.ts`, pool `'model-weights'`) with incremental SHA-256 verification |
| **True Streaming Compressed Audio** | Native FFmpeg/C++ demuxing & decode (`PHASE-03`) | Container-aware bounded decode (`AudioContext.decodeAudioData` guarded by `MemoryBudgetManager`); WAV true streaming already live (`PHASE-01`) |

---

## 2. Per-Model Native CPU vs Browser ONNX/WASM Feasibility Matrix

| Candidate Model | Quantized Artifact Footprint | Native CPU (Adobe Companion) Feasibility | Browser ONNX/WASM (Web App) Feasibility | Offline Readiness | Verdict |
| :--- | :---: | :--- | :--- | :---: | :--- |
| **`Qwen3-ASR-0.6B` (INT8 ONNX via `sherpa-onnx`)** | `~838 MB` archive (`conv_frontend` + `encoder` + `decoder` KV-cache ONNX + tokenizer) | **`HIGH` (`TIER-1`..`TIER-3`)** — Verified natively on `sherpa-onnx` v2.0.2 CPU; single unified multilingual FA/EN/Code-Switch architecture | **`CONSTRAINED_HIGH_RAM_ONLY`** — `~838 MB` INT8 + KV-cache runtime exceeds `1,024 MiB` `TIER-0`/`TIER-1` browser budget; requires `INT4` (`MatMulNBits`) split ONNX graph verification in `PHASE-05` or `TIER-2+` desktop browsers | **100% Offline** after install | **Primary Native `BALANCED` Candidate** (pending live bake-off metrics) |
| **`Qwen3-ASR-1.7B` (INT8 / GGUF)** | `~2.0–2.5 GB` INT8 | **`HIGH` (`TIER-2` / `TIER-3` Workstation)** — Strongest Qwen multilingual capacity; needs `>= 16 GB` host RAM | **`UNSUITABLE_FOR_WASM32`** — Exceeds browser WASM32 memory budget | **100% Offline** after install | **Native Workstation `QUALITY` Candidate** |
| **`OpenAI Whisper large-v3-turbo` (INT8 ONNX / GGML Q5)** | `~538 MB` ONNX INT8 / `~547 MB` GGML `q5_0` | **`HIGH` (`TIER-1`..`TIER-3`)** — Mature `whisper.cpp` + `sherpa-onnx` support across Windows/macOS x64/ARM64 | **`MEDIUM` (`TIER-2` Desktop Browsers Only)** — Quantized `q4`/`q8` ONNX fits `16+ GB` desktop Chrome/Edge, too heavy for `4–8 GB` / Safari mobile | **100% Offline** after install | **Primary Cross-Runtime Multilingual Benchmark Contender** |
| **`OpenAI Whisper base` / `small` (INT8 ONNX / GGML)** | `~198 MB` (`base` INT8) / `~610 MB` (`small` archive) | **`HIGH` (`TIER-0`..`TIER-1`)** — Fast native CPU fallback | **`HIGH` (`base` INT8 fits Browser `TIER-0`/`TIER-1` safely!)** — Well within `1,024 MiB` `MemoryPolicy` | **100% Offline** after install | **Browser-Safe Multilingual `LITE` Baseline** |
| **`NeMo FastConformer CTC Persian (Shenava Rizeh v1.0 INT8)`** | **`~29.6 MB` INT8 ONNX!** | **`EXCELLENT` (`TIER-0`..`TIER-3`)** — Sub-100ms cold start, ultra-low RAM, native streaming & non-streaming CTC | **`EXCELLENT` (ALL Desktop & Mobile Browsers incl. iOS Safari!)** — Single `~30 MB` INT8 ONNX graph fits trivially inside `384 MiB` mobile WASM limit | **100% Offline** after install | **Best Ultra-Light Persian-Only `LITE` Specialist (Cannot transcribe English/Code-Switch alone)** |
| **`Vosk` (`vosk-model-small-fa-0.42`)** | `~50 MB` Kaldi FST | `HIGH` (CPU speed), **`FAILS`** English & Code-Switching | `MEDIUM` (`vosk-browser` WASM, ~300 MB RAM) | **100% Offline** | **Disqualified as Primary** (fixed monolingual FST graph) |

---

## 3. Architectural Takeaway for Single-Engine / Two-Product Parity (`ADR-005`)

1. **Unified Runtime Family Win:** `sherpa-onnx` (`Apache-2.0`) natively runs **ALL THREE winning model architectures** (`Qwen3-ASR`, `Whisper`, and `NeMo FastConformer CTC`) through **one single C++/ONNX inference runtime** — eliminating the need to maintain separate Python/PyTorch/CTranslate2/Kaldi stacks inside the Adobe Audition Native Companion!
2. **Browser vs Native Weight Pairing:** Under `ADR-005`, both products share the exact same `AVAPARDAZ ASR CORE` contract, transcript schema, Persian normalizer (`FA-RELAXED-V1`), and logical model profiles (`AVP_MODEL_LITE`, `AVP_MODEL_BALANCED`, `AVP_MODEL_QUALITY`), while selecting platform-appropriate quantized ONNX artifacts so low-RAM browser tabs never OOM.
