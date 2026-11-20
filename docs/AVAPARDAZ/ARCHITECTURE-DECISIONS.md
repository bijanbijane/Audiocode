# AVAPARDAZ — ARCHITECTURE DECISION RECORDS (v3.0 — ADR-001 to ADR-018)

**Document ID:** `AVP-ADRS-3.0`  
**Phase:** `PHASE-00` (Architecture Freeze — Section 13 Complete)  
**Date:** 2026-11-20  
**Status:** FROZEN

---

## ADR-001 & ADR-002: Central Engine Architecture & Shared Core Implementation Language (Weighted Comparison — TASK AVP-P00-009)

### Weighted Evaluation Matrix (1–10 Scale)

| Criterion | Weight | Option A: TS Shared Orchestration + Native Inference Runtime + Browser WASM Runtime | Option B: Rust Shared Core + Native FFI + WASM Build | Option C: C/C++ Inference Core + Native API + WASM Build |
| :--- | :---: | :---: | :---: | :---: |
| Cross-platform compatibility | `15%` | **9** (Windows/macOS/Linux/mobile web + platform native adapters) | **7** (cross-compile + FFI matrix heavier; `cargo` absent in container) | **7** (Emscripten + MSVC/Clang matrix heavier) |
| CPU performance | `15%` | **9** (heavy neural compute runs in C/C++ Native or WASM SIMD; TS control plane <1% overhead) | **9** (native Rust + C++ FFI) | **10** (direct C/C++ SIMD/AVX2/NEON) |
| Browser compatibility | `15%` | **9** (native Vite/TS + Web Worker + `onnxruntime-web@1.31.1` already installed) | **7** (`wasm-bindgen` + ORT JS bridge friction) | **5** (Emscripten glue + high maintenance for UI/OPFS) |
| Adobe Audition integration | `15%` | **9** (CEP panel is HTML5/JS/TS + Companion loopback IPC natively shares TS contracts) | **7** (still requires TS CEP panel + IPC schema duplication) | **5** (still requires TS CEP panel + IPC bridge) |
| Code reuse | `10%` | **10** (reuses ~300+ existing TS modules in `src/asr-core`, `processing-engine`, `persian-linguistics`, `lifecycle`, `host-bridge`) | **4** (`wasm-audio-core` has only 2 `.rs` files; forces rewrite) | **1** (`0` C/C++ files exist in repo) |
| Memory safety | `10%` | **8** (GC-managed TS orchestration + explicit `MemoryBudgetManager` + isolated native inference) | **9** (Rust ownership, still unsafe FFI to C++ ORT/GGML) | **3** (manual memory management across full app) |
| Maintenance | `10%` | **9** (single contract language across Core, CEP Panel, Web App) | **6** (dual TS + Rust maintenance for every contract change) | **4** (slow iteration on Persian linguistics & UI contracts) |
| Packaging and distribution | `5%` | **8** (Node/pkg/SEA Companion + prebuilt native inference binary + Vite PWA) | **7** (Rust binary + separate WASM build) | **6** (per-OS/arch C++ + Emscripten builds) |
| Model ecosystem compatibility | `5%` | **9** (plugs `whisper.cpp`, `sherpa-onnx`, `onnxruntime`, `faster-whisper`, `Qwen3-ASR` behind one adapter) | **7** (depends on Rust crate bindings lagging upstream) | **8** (strong GGML/ORT C API, weak JS/browser ecosystem) |
| **WEIGHTED TOTAL** | **`100%`** | **`8.95 / 10` (WINNER)** | **`7.10 / 10`** | **`5.60 / 10`** |

### Decision (`ADR-001` & `ADR-002`)
- **ADR-001 (Central Engine):** Freeze **one single logical ASR engine (`AVAPARDAZ ASR CORE`)** shared across Product A (Adobe Audition Plugin, Priority `P1`) and Product B (Web Application, Priority `P2`).
- **ADR-002 (Core Language):** Select **Option A — TypeScript Shared Orchestration & Contracts + Pluggable Native CPU Inference Runtime + Browser WASM/ONNX Inference Runtime**, preserving existing `wasm-audio-core` (Rust Symphonia/Rubato DSP) without premature rewrite.

---

## ADR-003: Native CPU Runtime (`PHASE-03`)
- **Decision:** Run native CPU neural inference inside the Local Companion process via a pluggable `NativeInferenceAdapter` supporting the winning runtime(s) from the `PHASE-01` bake-off (`whisper.cpp` GGML/GGUF, `sherpa-onnx`, or ONNX Runtime Native C++).
- **CPU Floor:** Windows/macOS `x86_64` baseline `SSE4.2` (optional runtime dispatch to `AVX2`/`AVX-512`; **AVX2 MUST NOT be mandatory**); `ARM64` with `NEON`.

---

## ADR-004: Browser CPU Runtime (`PHASE-05`)
- **Decision:** Run browser local neural inference exclusively inside a dedicated Web Worker (`studio-asr.worker.ts` / `StudioAsrWorkerClient.ts`) using `onnxruntime-web` (`^1.31.1` already installed) with local WASM binaries served from `/public/ort/`.
- **Fallback Chain:** `WASM_THREADS + WASM_SIMD` (when `crossOriginIsolated` + actual WASM SIMD bytecode probe pass) -> single-threaded `WASM_SIMD` -> `WASM_BASELINE`. Optional `WebGPU` only with automatic fallback to `WASM_SIMD`. **NEVER** fall back to server/cloud APIs.

---

## ADR-005: Model Format Strategy
- **Decision:** Allow platform-optimal weight formats behind identical logical model IDs, contracts, and evaluation gates (e.g., quantized GGML/GGUF or INT8 ONNX for Native Companion; quantized INT8/UINT8 ONNX for Browser WASM). Never force one suboptimal binary container across both runtimes if CPU speed or RAM ceilings degrade.

---

## ADR-006: Model Distribution Architecture
- **Decision:** Strictly decouple model weight binaries from the Git source-code repository. Distribute versioned model packages via signed/checksummed manifests (`Model ID`, `Version`, `Revision`, `Weight SHA-256`, `Tokenizer SHA-256`, `Config SHA-256`, `License SPDX`, `Byte Size`, `Quantization`, `Minimum Tier`, `Supported Runtimes`) with support for resumable chunked downloads AND offline local file import.

---

## ADR-007: Adaptive Hardware Detection (`TASK AVP-P00-008`)
- **Decision:** Consolidate and repair existing `src/runtime/ResilientAiRuntime.ts`, `src/runtime/HardwareBenchmarkProfiler.ts`, `src/runtime/memory/MemoryBudgetManager.ts`, and `src/performance/AdaptiveDegradationController.ts` into 5 clean modules without duplication:
  1. **`DeviceCapabilityDetector`** (Browser: `hardwareConcurrency`, `deviceMemory` with conservative `UNKNOWN` handling—removing `ResilientAiRuntime.ts:51` hardcoded `8` GB fallback—`storage.estimate()`, `crossOriginIsolated`, `SharedArrayBuffer`, and **actual WASM SIMD bytecode `WebAssembly.validate()` probe**; Native: OS/arch/CPUID `SSE4.2`/`AVX2`/`NEON`, physical & available RAM, disk space). Zero User-Agent CPU guessing; zero remote fingerprinting.
  2. **`AdaptiveRuntimeSelector`** (selects compatible Native or WASM backend per verified capabilities).
  3. **`AdaptiveModelSelector`** (maps detected Tier + empirical CPU score + available memory to highest safe model profile, with user override allowed and strict zero-cloud-fallback guarantee).
  4. **`ResourceBudgetManager`** (extends existing `MemoryBudgetManager` + `AdaptiveDegradationController` to reserve model + audio window budgets, cap concurrency, and unload idle sessions under pressure).
  5. **`ModelCompatibilityRegistry`** (data-driven compatibility matrix populated from `PHASE-01` benchmarks).

---

## ADR-008: Model Selection Profiles & Hardware Tiers
- **Decision:** Standardize 4 hardware evaluation tiers (`TIER-0: LOW_RESOURCE 4–8GB`, `TIER-1: MAINSTREAM 8–16GB`, `TIER-2: PERFORMANCE 16–32GB`, `TIER-3: WORKSTATION 32GB+`) and 3 product model profiles (`AVP_MODEL_LITE`, `AVP_MODEL_BALANCED`, `AVP_MODEL_QUALITY`).
- **Rule:** Never hardcode Apple M2 or any single device as the universal baseline. No model is assigned to `LITE`, `BALANCED`, or `QUALITY` until `PHASE-01` CPU benchmarks prove real CER/WER/RTF/RAM compliance.

---

## ADR-009: Shared Audio Pipeline
- **Decision:** Standardize canonical ASR input to `16,000 Hz` Mono Float32/PCM16 with stereo phase inspection (`CoreAudioIngestion.ts`), anti-aliased resampling (`resampler.ts`), bounded chunking/VAD segmentation (10–30s windows with overlap/silence valleys depending on tier), and strict `MemoryBudgetManager` reservation before allocation.

---

## ADR-010: Shared Transcript Contract
- **Decision:** Both Adobe Audition Plugin and Web App MUST consume one versioned, platform-neutral `AvapardazTranscriptResult` (`v2.0.0`, defined in `ENGINE-INTERFACE-SPEC.md`) separating `rawText`, `normalizedText`, `normalizedByProfile`, word-level spans with explicit `timestampOrigin`, speaker labels, calibrated/uncalibrated `confidenceStatus`, and honest runtime metadata (`isGenuineNeuralModel`, `executedOffline`).

---

## ADR-011: Native Companion Architecture
- **Decision:** Deploy a standalone per-OS/per-arch Native Companion process managing native CPU inference, local disk model storage, long-file chunking, cancellation, temporary WAV lifecycle/cleanup, and loopback-only (`127.0.0.1` / `::1`) authenticated IPC (`CompanionIpcBridge.ts`: protocol `1.0.0`, ephemeral HMAC-SHA256 session tokens, nonce replay guard, origin/CSRF checks, request size & rate limits). Never bind to `0.0.0.0` by default.

---

## ADR-012: Adobe Audition Extension Architecture (`P1` Priority)
- **Decision:** Implement Product A as an **Adobe Audition CEP Extension** (`CSXS/manifest.xml`, HTML5/TypeScript panel UI, ExtendScript `.jsx` host bridge) communicating over loopback HMAC IPC with the Native Companion. Works completely independently of the Web App.
- **Boundary:** Do NOT assume UXP support in Audition without official Adobe Audition SDK proof; defer VST3/AU audio effects to a separate future track. Where Audition ExtendScript lacks direct buffer/timeline mutation APIs, use managed temporary WAV export + non-destructive `.sesx v1.9` interchange (`AuditionHostAdapter.ts`). All desktop Host APIs remain `UNVERIFIED` until tested on desktop Windows/macOS Audition.

---

## ADR-013: Web Application Integration Architecture (`P2` Priority)
- **Decision:** Wire `src/App.tsx` to `AVAPARDAZ ASR CORE` via `StudioAsrWorkerClient` -> `studio-asr.worker.ts` -> `WebWorkerOrtRuntimeProvider` (`onnxruntime-web` WASM SIMD) + OPFS chunked storage + offline Service Worker (`public/sw.js`). Decouple and remove mandatory/accidental cloud ASR routes (`/api/v1/asr/transcribe`, `@google/genai`) from the studio UI.

---

## ADR-014: Offline Model Installation
- **Decision:** "Offline-capable" applies to Avapardaz ASR processing after initial model installation/provisioning (never claiming Adobe's own licensing is offline-independent). Both Web App (OPFS chunked store + local file import) and Native Companion (local versioned model directory + offline bundle import) MUST support resumable install, atomic commit, corruption detection, uninstall, and mandatory offline SHA-256 verification before loading.

---

## ADR-015: Privacy & Local Execution Security (`TASK AVP-P00-011`)
- **Decision:** Enforce zero silent audio exfiltration (`LOCAL` default, zero fallback to cloud APIs), loopback-only authenticated Companion IPC, zero hardcoded secrets in client/CEP bundles, sanitized telemetry (`sanitizeSecurityTelemetry`), managed temporary audio cleanup, and strict SHA-256 (plus OS code signing where supported) integrity verification on every model artifact.

---

## ADR-016: Cross-Platform Packaging & Release
- **Decision:** Build platform-specific release artifacts in `PHASE-09`: Windows `x86_64` (and `ARM64` if supported by target Audition release) Companion installer, macOS `ARM64` + `x86_64` signed Companion package, signed Adobe `.zxp`/CEP extension, Vite PWA web bundle with local `/ort/` assets, and independent checksum-verified model packs.

---

## ADR-017: Dataset Development Strategy (`TASK AVP-P00-010`)
- **Decision:** Preserve the existing Frozen Test Set policy (`DATASET/SPLIT-POLICY.md`: `0%` speaker leakage, SHA-256 deduplication, 11 QC gates in `DATASET/QUALITY-CONTROL.md`) while addressing the observed deficit (`0` real audio files on disk). Expand with commercially-cleared Persian, English, and Persian-English Code-Switching speech (auditing `FLEURS`, `Common Voice`, and consented studio recordings independently for commercial rights). Never use synthetic transcripts as human ground truth.

---

## ADR-018: Future Model Specialization & Fine-Tuning Strategy
- **Decision:** Explicitly follow the empirical ladder — distinguishing (1) **Pretrained Model Acquisition**, (2) **Domain Adaptation** (lexicon/contextual biasing/post-ASR Persian linguistics), (3) **LoRA** (parameter-efficient adaptation on compatible models), (4) **Full Fine-Tuning**, and (5) **From-Scratch Training** (`NO_GO` per `ARCHITECTURE-RESEARCH/FROM-SCRATCH-READINESS.md` due to `BELOW_D0` data and `G0_CPU_ONLY` hardware). Start with Pretrained Acquisition (`PHASE-01`), establish baseline benchmarks, then apply Domain Adaptation and GPU-backed LoRA/Fine-Tuning (`PHASE-06`) while guaranteeing CPU-first inference on consumer devices.
