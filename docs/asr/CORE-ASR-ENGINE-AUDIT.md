# CORE ASR ENGINE AUDIT (MILESTONE CORE-01)

**Audit Timestamp (UTC):** 2026-11-18T20:08:00Z  
**Workspace:** `/app/applet`  
**Classification Standard:** Strict observed runtime/code verification (`VERIFIED_IMPLEMENTED`, `IMPLEMENTED_UNVERIFIED`, `PARTIALLY_IMPLEMENTED`, `EXPERIMENTAL`, `MOCKED`, `DOCUMENTED_ONLY`, `MISSING`, `BLOCKED`)

---

## 1. Observed Hardware & System Environment (`[Observed Fact]`)

| Resource / Binary | Measured State | Impact on Core ASR Engine |
| :--- | :--- | :--- |
| CPU / Architecture | `x86_64`, **4 vCPUs** (`Linux 4.19.0-gvisor`) | Supports TypeScript/Node.js CPU signal DSP, FFmpeg decoding, CTC/Viterbi decoding, benchmark/CI math, and unit/Vitest suites. |
| System Memory | **12 GiB RAM**, `0 B` Swap (`~11 GiB` available) | Sufficient for Node.js/Vitest, FFmpeg, multi-minute PCM audio buffers, and small CPU ONNX/feature models. |
| GPU / CUDA | **None** (`nvidia-smi` absent) | Full/LoRA GPU training (`Qwen3-ASR-1.7B`, `Whisper-Large-v3`) and CUDA vLLM serving are **BLOCKED**. |
| Media Codecs | `/usr/bin/ffmpeg` and `/usr/bin/ffprobe` installed | Real decoding and container/stream probing for WAV, FLAC, MP3, OGG, M4A/AAC, WebM are runnable locally. |
| Python ML Stack | Python `3.11.2`; `torch`, `torchaudio`, `transformers`, `faster_whisper`, `whisper`, `onnxruntime`, `numpy`, `scipy`, `librosa`, `soundfile` are **ALL MISSING** | No Python neural inference or PyTorch training can execute in this container without external wheel/env provisioning. |
| Model Weight Files | **0 files** matching `*.onnx`, `*.safetensors`, `*.gguf`, `*.pt`, `*.spm` on disk | No real pretrained neural weights (Whisper / Qwen3-ASR / FastConformer ONNX) are present on disk. |
| Rust / Cargo | `cargo` **absent** | WASM Core (`wasm-audio-core/`) TypeScript wrappers work, but fresh Rust recompilation is blocked locally. |

---

## 2. Existing Engine Component Audit

| Component | Actual Source File(s) | Status | Runtime Reality & Critical Findings |
| :--- | :--- | :--- | :--- |
| **Studio Primary `/api/v1/asr/transcribe`** | `server.ts` (L126–194), `src/engine/persianAsrTranscriber.ts` (L525–556) | **PARTIALLY_IMPLEMENTED / EXTERNAL_DEPENDENT** | Calls `GoogleGenAI` (`gemini-3.5-transcribe`) when `GEMINI_API_KEY` is set; returns `503 ASR_API_KEY_UNAVAILABLE` otherwise. Offline fallback `buildOfflineAcousticSegmentedTranscript()` only emits placeholder burst tokens (`گفتارِ اول`, `بخشِ_i`) — does NOT perform genuine independent audio-to-text recognition. |
| **Audio Input Validation & Anti-SSRF Guard** | `src/security/AudioSecurityGuard.ts`, `src/security/AudioIngestionAndUrlGuard.ts`, `src/ai-engine/asr/PreAsrInputSanityValidator.ts` | **VERIFIED_IMPLEMENTED** | Magic-byte checks (WAV/MP3/FLAC/OGG/M4A/WEBM), decompression bomb ratio guard (<=250x), RIFF size bounds, SNR/clipping/DC-offset sanity check, and strict anti-SSRF guard verified by `node:test` and `vitest`. |
| **WAV Parser & FFmpeg Ingestion** | `backend/src/asr-worker/NodeOnnxAsrBenchmarkRunner.ts`, `src/data-factory/AudioIngestionAndQcEngine.ts` | **VERIFIED_IMPLEMENTED** | RIFF/WAV 16/24/32-bit parser and real FFmpeg decode/inspect tested on WAV & MP3. Needs unified Core Batch Ingestion entry point validating FLAC/OGG/M4A/WebM end-to-end. |
| **Polyphase Resampling & Channel/Phase Safety** | `src/engine/resampler.ts`, `src/ai-engine/AntiAliasedResampler.ts`, `packages/audio-runtime/src/ChannelAndPhaseAlignmentEngine.ts` | **VERIFIED_IMPLEMENTED** | 48k/44.1kHz -> 16kHz anti-aliased sinc resampling & stereo correlation/phase-cancellation checks verified by unit tests (`14kHz` attenuation verified). |
| **Voice Activity Detection (Silero Runner)** | `src/ai-engine/asr/SileroVadOnnxRunner.ts`, `src/ai-engine/asr/RealTimeStreamingAsrEngine.ts` | **PARTIALLY_IMPLEMENTED** | Dual-hysteresis energy/Silero-compatible VAD works natively in CPU; actual `silero_vad.onnx` session requires external ONNX weights + `onnxruntime-node`. |
| **ONNX ASR Runtime & KV Cache / Beam Decoder** | `src/ai-engine/asr/UnifiedOnnxPersianAsrEngine.ts`, `PersianCtcPrefixBeamSearchDecoder.ts`, `WhisperBeamSearchAndTempFallbackEngine.ts`, `WhisperKvCacheAutoregressiveOptimizer.ts` | **IMPLEMENTED_UNVERIFIED (No Weights)** | Math, UTF-8 byte-BPE mapping, CTC prefix beam search + Context Biasing Trie, and KV-cache orchestration are implemented and pass tests using mock ORT sessions, but no real `.onnx` model or `onnxruntime-node` binary is installed to run real neural weights yet. |
| **Independent Model Development (`Phase 4`)** | `src/ai-engine/asr/IndependentAsrModelDevelopmentEngine.ts` | **EXPERIMENTAL** | `runIndependentAsrTranscription` transforms text from fixed corpus rows (`INITIAL_VERIFIED_STUDIO_CORPUS`) through trainable bigram/lexicon weights (`ASR-FA-EN-1.0.0-RC1`) rather than decoding raw acoustic audio frames directly. |
| **Persian, English & Code-Switch Normalization** | `src/ai-engine/asr/AsrDatasetAndBehavioralBenchmarkEngine.ts`, `MultilingualCodeSwitchAndArabicEngine.ts`, `PersianPostAsrSpellingAndCompoundRestorer.ts` | **VERIFIED_IMPLEMENTED** | Versioned `fa_strict_v1`, `fa_relaxed_v1`, `en_norm_v1`, `mixed_norm_v1` normalization and Levenshtein CER/WER/MER evaluation exist and pass tests. |
| **Long-Form Chunking & Stitching** | `src/ai-engine/PersianChunkedAsrWorker.ts`, `src/ai-engine/asr/IntegratedPersianAsrService.ts` | **PARTIALLY_IMPLEMENTED** | Feeds overlapping windows to `AsrModelRunnerAdapter`, but lacks unified batch orchestrator with boundary-aware VAD snapping, overlap text deduplication, per-segment retry recovery, and explicit missing-range accounting. |
| **Real-Time Streaming Pipeline (`Phase 5`)** | `src/ai-engine/asr/RealTimeStreamingAsrEngine.ts`, `StreamingLivePersianAsrEngine.ts`, `src/security/StreamingSecurityGuard.ts` | **PARTIALLY_IMPLEMENTED** | Binary `ASR1` framing, sequence validator, backpressure queue (`NORMAL/WARNING/CRITICAL`), single-use HMAC tokens, and partial revision tracking exist, but lack unified runnable streaming session engine wiring real PCM frame decoding + `transcript.partial`/`revision`/`final`/`session.overloaded` events cleanly in one Core ASR API. |
| **Minimum Model Router (`Phase 6`)** | `src/ai-engine/asr/AdaptiveAsrRouterEngine.ts` | **VERIFIED_IMPLEMENTED** | Policy/privacy/local-first router works deterministically; needs a simplified Core-ASR router slice isolated from unrelated product billing metrics. |
| **Baseline Test Suite Health (Before CORE-02)** | `npm run test:unit` + `npx vitest run` | **VERIFIED_IMPLEMENTED** | `255 / 255` `node:test` tests and `77 / 77` Vitest tests currently PASS (`0` TS errors). |

---

## 3. Fastest Technically Sound Path to a Real Independent Core Engine

Because this container has **no GPU, no PyTorch, and no pre-downloaded `.onnx`/`.safetensors` weights**, honesty requires separating **two tracks**:
1. **CPU-Executable Core Engine (Ready Immediately — `Level A Baseline + Level B Adapter`):**
   - Build a unified, self-contained **Core ASR Engine (`/src/asr-core/`)** that decouples core recognition completely from CRM/billing/meeting-analytics:
     - **Real FFmpeg + Native Media Ingestion** supporting WAV, MP3, FLAC, OGG, M4A/AAC, WebM -> canonical 16kHz Mono PCM16 WAV (while keeping original audio + stereo channel inspection).
     - **Signal-Level Local Acoustic MFCC/Mel-Energy Frame Extractor + Trainable Acoustic Prototype CTC Decoder (`CoreAcousticCtcEngine`)** plus **Pluggable External ONNX / Python Neural Runtime Adapter**: executes real signal-to-token recognition on CPU from actual waveform frames (no cloud API calls, no reading answers from request metadata!) while failing honestly with explicit error codes when external neural weights (`Qwen3-ASR`, `Whisper`, `FastConformer`) are unavailable.
     - **True Long-Form Boundary-Aware Pipeline** with speech-valley segmentation, context overlap, overlap phrase deduplication, sample-accurate timestamp restoration, retry recovery, and memory/RSS measurement.
     - **True Event-Driven Streaming Session Pipeline** classifying execution mode explicitly (`STATEFUL_CHUNKED_STREAMING` / `VAD_SEGMENTED_BATCH` / `NATIVE_INCREMENTAL_STREAMING`), handling 100/250/500/1000ms packets, partial/revision/final events, zero silent drops, and bounded backpressure.
     - **Independent Persian (`FA-STRICT-V1` / `FA-RELAXED-V1`), English (`EN-NORM-V1`), and Code-Switching (`MIXED-NORM-V1`) Benchmarks** with 10,000-iteration paired bootstrap CIs and real FFmpeg audio regression tests.
2. **External GPU / Open-Weight Provisioning Track (`BLOCKED` Outside This Container):**
   - Mounting `onnxruntime-node` + verified `.onnx` weights (e.g., `whisper-tiny/base/turbo.onnx` or `fastconformer-fa.onnx`) or a GPU worker running `Qwen/Qwen3-ASR-1.7B` slots directly into `CoreAsrRuntimeBackend` with zero rewrites.

---

## 4. Prioritized Deficiencies to Remediate Immediately

1. **`P0` No unified independent local `/v1/asr-core/batch` and streaming runtime:** Existing `/api/v1/asr/transcribe` depends on Gemini API and falls back to fixed strings; `/api/v1/asr/transcriptions` reads fixed corpus IDs instead of decoding real uploaded audio files.
2. **`P0` Multi-format end-to-end decoding tests missing for FLAC, OGG, M4A/AAC, WebM:** Only WAV & MP3 have passing ingestion tests today.
3. **`P0` Long-form stitching, overlap deduplication, and failed-segment visibility:** Needs explicit boundary deduplication, retry logic, and missing-range fail-closed enforcement.
4. **`P1` Separate clean FA, EN, MIXED-NORM-V1 evaluation runner + 10k paired bootstrap + honest confidence/timestamp semantics** (explicit `'UNAVAILABLE_UNCALIBRATED'` instead of invented scores when raw decoder lacks calibration).
5. **`P1` Studio DAW UX Request:** Deliver Adobe Audition–style workspace (`Player` + `Range Selection` + `Spectrum/Waveform` + `Master Meter`) cleanly connected to Core Studio.
