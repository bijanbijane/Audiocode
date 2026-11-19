# Avapardaz Implementation Ledger

## Project Baseline
- **Repository:** `bijanbijane/Audiocode` (Avapardaz — Local-First Intelligent Persian Speech Editing Studio)
- **Initial Inventory (`[OBSERVED]`):** `src/` = 292 files, `backend/` = 63 files, `packages/` = 38 files, `wasm-audio-core/` = 5 files, `public/` = 9 files, root `README.md` = missing.
- **Initial Baseline Tests (`[TESTED]`):** `npm run lint` (0 errors), `npx vitest run` (17 files / 79 tests passed), `npm run test:unit` (38 suites / 261 tests passed), `npm run build` (1749 modules built; only `ioBroker.worker` bundled).

## Architecture Decisions
- **AD-001 (Phase 00 Scope Narrowing):** Product scope frozen exclusively on local-first Persian speech editing (import -> verbatim ASR + alignment -> speech analysis -> user-approved review/cuts -> clean streaming export). Research Lab, Developer Portal, Data/Model Factory, Speech Security SaaS, and Commercial Multi-Provider Cloud APIs are out of primary user runtime.
- **AD-002 (Local-Only Privacy):** All user audio decoding, inference, analysis, and rendering must run locally in the browser without calling `@google/genai` or external cloud inference APIs.
- **AD-003 (Memory Budget Policy):** Adopt `AVAPARDAZ_MEMORY_POLICY` (`targetBytes = 850 MiB`, `throttleBytes = 900 MiB`, `emergencyBytes = 950 MiB`, `hardLimitBytes = 1,024 MiB`, `audioCacheBytes = 32 MiB`) with documented browser telemetry limits.
- **AD-004 (No Premature Modification in Phase 00):** Zero production code, package dependencies, UI components, or server routes modified during `AVP-P00-001`.

## Completed Phases
- *(None prior to `AVP-P00-001`; Phase 00 deliverables completed as documented below, awaiting user verification before `AVP-P01-001`.)*

## Current Phase
- **Mission ID:** `AVP-P00-001` — **Phase 00: Product Reality Audit, Runtime Traceability & Architecture Freeze**
- **Status:** **COMPLETED (Audit & Documentation Only — Awaiting Review Before `AVP-P01-001`)**

## Modified Files
- *(None during Phase 00 — per `AVP-P00-001` Section 2.2 No Premature Implementation rule. Pre-Phase-00 environment bring-up files from GitHub migration: `.env.example`, `vite.config.ts`, deleted `bun.lock`.)*

## Added Files
- `docs/AVAPARDAZ/CURRENT-STATE.md`
- `docs/AVAPARDAZ/REPOSITORY-INVENTORY.md`
- `docs/AVAPARDAZ/RUNTIME-DEPENDENCY-MAP.md`
- `docs/AVAPARDAZ/AUDIO-EXECUTION-TRACE.md`
- `docs/AVAPARDAZ/ASR-REALITY-AUDIT.md`
- `docs/AVAPARDAZ/CLOUD-DEPENDENCY-REGISTER.md`
- `docs/AVAPARDAZ/MEMORY-ALLOCATION-MAP.md`
- `docs/AVAPARDAZ/BROWSER-CAPABILITY-MATRIX.md`
- `docs/AVAPARDAZ/STORAGE-AND-RECOVERY-AUDIT.md`
- `docs/AVAPARDAZ/UI-PRODUCT-SCOPE.md`
- `docs/AVAPARDAZ/TEST-BASELINE.md`
- `docs/AVAPARDAZ/TARGET-ARCHITECTURE.md`
- `docs/AVAPARDAZ/PHASE-01-IMPLEMENTATION-SPEC.md`
- `docs/AVAPARDAZ/IMPLEMENTATION-LEDGER.md`
- *(Supplemental audit docs from initial pass: `docs/AVAPARDAZ/ASR-EXECUTION-TRACE.md`, `docs/AVAPARDAZ/DEAD-CODE-REGISTER.md`)*

## Reused Components
*(Cataloged for Phase 01+ reuse without duplication)*
- `src/engine/dsp.ts`, `src/engine/processingGraph.ts`, `src/engine/resampler.ts`, `src/engine/peakPyramid.ts`, `src/engine/timebase.ts`, `src/engine/timeline.ts`, `src/engine/lruCache.ts`, `src/engine/storageBroker.ts`
- `src/processing-core/ParallelChunkRenderCoordinator.ts`, `StreamingExportEncoder.ts`, `ProcessingGraphEngine.ts`, `ExportValidator.ts`
- `src/ai-engine/OnnxPersianAsrAndVadAdapter.ts`, `PersianChunkedAsrWorker.ts`, `PersianCtcForcedAligner.ts`, `PersianTextNormalizer.ts`, `UnifiedOnnxPersianAsrEngine.ts`, `WebWorkerOrtRuntimeProvider.ts`
- `src/runtime/HardwareBenchmarkProfiler.ts`, `CrashRecoveryAndSessionLock.ts`, `ResilientAiRuntime.ts`, `src/security/AudioSecurityGuard.ts`
- `packages/audio-runtime/src/StreamingPlaybackPumpController.ts`, `DirectStudioOpfsRecorder.ts`, `src/audio-engine/SharedRingBuffer.ts`

## Removed Dependencies
- *(None removed during Phase 00 — `@google/genai` and cloud routes remain inventoried for removal/isolation in Phase 01+.)*

## Verified Test Results
- `npm run lint` (`tsc --noEmit`): Exit `0`, 0 errors.
- `npx vitest run`: Exit `0`, 17 files / 79 tests passed (`5.14s`).
- `npm run test:unit` (`tsx --test`): Exit `0`, 38 suites / 261 tests passed, 0 failed (`29.11s`).
- `npm run build` (`vite build`): Exit `0`, 1749 modules transformed (`1.14s`).
- `npm run start` (`node server.ts`): **FAIL** in Node v22 strip-only TS mode (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at `src/ai-engine/asr/AsrExperimentationLabCore.ts:830`).

## Memory Measurements
- **Measured Browser Tab / Real Long-File Runtime Memory:** `UNKNOWN` (no long-file browser memory harness exists yet; math shows full-file 48kHz stereo Float32 decode for 1h = `1,318.36 MiB`, exceeding `1,024 MiB` hard policy before ASR).
- **Logical LRU Cache Configured in `App.tsx:208`:** `8 MiB` (mismatched with `32 MiB` initial UI telemetry state; unused during file upload/playback/export).

## Benchmark Results
- **Real Local Neural ASR CER/WER/RTF:** `UNKNOWN` (zero `.onnx` weights and missing `onnxruntime-web` package; existing benchmarks in `BENCHMARK/` and `AsrExperimentationLabCore` are corpus/simulation/server-metadata suites, not browser neural inference on raw speech).

## Known Issues
1. `App.tsx:601` calls cloud-backed `/api/v1/asr/transcribe` (`server.ts:133` `@google/genai`), falling back to synthetic words in `buildOfflineAcousticSegmentedTranscript()`.
2. `ingestUploadedAudioFile` (`audioFixtures.ts:447-469`), `streamingChunkedRender` (`audioPlayback.ts:132`), and `encodeAndValidateWavExport` (`storageBroker.ts:282`) allocate full-duration audio buffers in RAM.
3. `public/sw.js:17` injects `COEP: require-corp` conflicting with `server.ts:126` `credentialless`, while `index.html:20-22` requests external Google Fonts CDN.
4. `IndexedDB` is unused; `writeRecoveryCheckpoint()` is never called during edits in `App.tsx`.
5. `wasm-audio-core` has Rust sources but 0 compiled `.wasm` artifacts in repository.

## Deferred Work
- `AVP-P01-001`: Local Runtime, Cloud Removal, OPFS Block Streaming, and `MemoryBudgetManager`.
- Phase 02+: `onnxruntime-web` installation, real `.onnx` model packaging & verification, real browser ASR worker integration.
- Phase 04/07: UI simplification (hiding 6 non-core modals, consolidating `?shell=v12` duplicate shell).

## Next Authorized Mission
- **`AVP-P01-001`** *(Not started — Blocked pending explicit user review and authorization after `AVP-P00-001` completion report).*
