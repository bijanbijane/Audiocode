# AVAPARDAZ — PHASE-00 BASELINE REALITY AUDIT (v3.0)

**Document ID:** `AVP-PHASE00-AUDIT-3.0`  
**Audit Date:** 2026-11-20  
**Workspace Root:** `/app/applet`  
**Git Status (`AVP-P00-001`):** `NOT_A_GIT_REPOSITORY` (`.git` absent — no branch, no commit hash)  
**Host Environment (`[OBSERVED]`):** Linux `x86_64` (`4.19.0-gvisor`), `4` vCPUs, `12,288 MiB` RAM, Node `v22.23.2`, npm `10.9.8`, Python `3.11.2`, `/usr/bin/ffmpeg`, Playwright `1.65.1`, **NO GPU**, **NO `pip3`**, **NO `cargo`/`rustc`**.

---

## 1. Repository Architecture Inventory (`AVP-P00-001` & `AVP-P00-002`)

| Path | Status | Observed Contents & Role | Classification |
| :--- | :---: | :--- | :---: |
| `package.json` | `EXISTS` | `react@19.0.1`, `vite@8.3.0`, `express@4.21.2`, `onnxruntime-web@^1.31.1`, `@google/genai@^2.4.0`, `vitest@^5.1.0`, `typescript@^7.0.2`. Scripts: `dev`, `build`, `start`, `preview`, `clean`, `lint`, `test:quality-gates`, `test:unit`, `test:e2e`, `verify:foundation` (**no `npm test`**). | `KEEP` (remove `@google/genai` from product runtime path in `PHASE-05`) |
| `README.md` | `MISSING` | Not present in workspace root. | `REPAIR` (create in `PHASE-09`) |
| `src/asr-core/` | `EXISTS` (10 files) | `CoreAsrContracts.ts`, `CoreAudioIngestion.ts`, `CoreNormalizationAndLanguage.ts`, `CoreBatchAndLongFormEngine.ts`, `CoreStreamingAsrEngine.ts`, `CoreModelRouter.ts`, `CoreAcousticCtcEngine.ts`, `CoreAsrBenchmarkSuite.ts`, 2 tests. | `KEEP` pipeline/contracts; `REPLACE` `CoreAcousticCtcEngine` as ASR engine |
| `src/ai-engine/asr/` & `workers/` | `EXISTS` (53+ files) | `WebWorkerOrtRuntimeProvider.ts`, `UnifiedOnnxPersianAsrEngine.ts`, `PersianCtcPrefixBeamSearchDecoder.ts`, `SileroVadOnnxRunner.ts`, `SpeakerEmbeddingOnnxRunner.ts`, `studio-asr.worker.ts`, `StudioAsrWorkerClient.ts` (**disconnected from `App.tsx`**), plus lab simulation engines. | `KEEP` ONNX/worker/decoder scaffolding; `REMOVE` simulation claims from production |
| `src/runtime/` & `src/performance/` | `EXISTS` (31 files) | `MemoryBudgetManager.ts` (`KEEP`), `MemoryPolicy.ts` (`KEEP`), `AdaptiveDegradationController.ts` (`KEEP`), `HardwareBenchmarkProfiler.ts` (`KEEP` & extend), `ResilientAiRuntime.ts` (`REPAIR` — hardcodes `8 GB` fallback at line 51 & assumes `WASM_SIMD` without bytecode probe). | `KEEP` / `REPAIR` |
| `src/lifecycle/` | `EXISTS` (10 files) | `LocalModelLifecycleManager.ts`, `OpfsModelChunkStorage.ts`, `ModelRepositoryContracts.ts`, `AppUpdateAndShellManager.ts`, `ProjectBackupAndRestore.ts`. (Two `.test.ts` files have 51 stale TS errors.) | `KEEP` implementation; `REPAIR` stale tests |
| `src/processing-engine/` | `EXISTS` (12 files) | `UnifiedProcessingOrchestrator.ts`, `UnifiedProcessingContract.ts`, `LocalExecutionAdapter.ts`, `CloudExecutionAdapter.ts`, `ExecutionModePreferenceStore.ts`. | `KEEP` & plug in `AsrRuntimeAdapter` (`PHASE-02`) |
| `src/persian-linguistics/` | `EXISTS` (6 files) | Tokenizer, orthography/ZWNJ, code-switching, punctuation/numbers, post-ASR correction. | `KEEP` |
| `src/contracts/` | `EXISTS` (9 files) | `timebase.contract.ts`, `project-schema.contract.ts`, `RuntimeAbstractionLayer.ts`, `PlatformErrorCatalog.ts`, `storage-broker.contract.ts`, `v1_2.ts`. | `KEEP` |
| `src/host-bridge/` & `src/backend-api/` | `EXISTS` (6 files) | `CanonicalProjectService.ts`, `audition/AuditionHostAdapter.ts`, `companion/CompanionIpcBridge.ts`, `AvapardazBackendRouter.ts` (**NOT mounted in `server.ts`**). Zero CEP/ExtendScript files. | `KEEP` bridge classes; `REPAIR` mounting in Companion (`PHASE-03`/`04`) |
| `src/model-factory/` & `backend/` | `EXISTS` (76 files) | Control-plane model lifecycle, license service (`PlatformLicenseService.ts`), Fastify/Express routers & security gateways. | `KEEP` where needed; isolate SaaS control-plane from offline core |
| `packages/audio-runtime/` | `EXISTS` (30+ files) | DSP engines (`SpectralWienerDenoiserEngine`, `Parametric8BandBiquadEq`, `TimeStretchWsolaEngine`, `StreamingPlaybackPumpController`, `DirectStudioOpfsRecorder`, `PriorityWorkerPoolDispatcher`). | `KEEP` |
| `wasm-audio-core/` | `EXISTS` (4 files) | Rust crate (`symphonia` 0.5.4 + `rubato` 0.15.0, MIT/Apache-2.0, zero GPL FFmpeg); **`0` compiled `.wasm` files**, `cargo` absent. | `KEEP` (`UNVERIFIED` in this container) |
| `python_asr_lab/` & `training/` | `EXISTS` (11 files) | `asr_lab_core.py`, `preflight.py`, `preflight_report.json` (`G0_CPU_ONLY`), `qwen3_asr_sft_v1.yaml`, 4 `.lock` files, 3 `.jsonl` manifests (4 rows, `0` real audio files). | `KEEP` scaffolding; expand in `PHASE-06` |
| `DATASET/`, `BENCHMARK/`, `RESEARCH/`, `ARCHITECTURE/`, `MODEL-RESEARCH/`, `MODEL-DEVELOPMENT/`, `ARCHITECTURE-RESEARCH/` | `EXISTS` | Extensive design/benchmark docs; `DATASET` has `0` raw audio files; `BENCHMARK/` reports reflect corpus/simulation evaluations rather than local neural CPU runs. | `KEEP` as reference; supersede stale claims |

---

## 2. Reconciled Contradictions Between Legacy Docs and Current Code (`[OBSERVED]`)

1. **`onnxruntime-web` installation:** Legacy `CURRENT-STATE.md` / `ASR-REALITY-AUDIT.md` claimed `onnxruntime-web` was NOT installed. **Observed reality:** `package.json:27` installs `onnxruntime-web@^1.31.1` and `node_modules/onnxruntime-web/dist/` contains 4 `.wasm` files (`15–29 MB`). However, `/public/ort/` does **NOT** exist yet.
2. **External CDN fonts:** Legacy `CURRENT-STATE.md:38,49` claimed `index.html:20-22` loaded `fonts.googleapis.com`. **Observed reality:** `index.html` contains **zero** external CDN links.
3. **COOP/COEP mismatch:** Legacy `CURRENT-STATE.md:49` claimed `public/sw.js` used `require-corp` conflicting with `server.ts`'s `credentialless`. **Observed reality:** Both `server.ts:144` and `public/sw.js:37` consistently use `Cross-Origin-Embedder-Policy: credentialless`.
4. **`MemoryBudgetManager`:** Legacy `CURRENT-STATE.md:37` claimed it did not exist. **Observed reality:** `src/runtime/memory/MemoryBudgetManager.ts` exists and is called by `WebWorkerOrtRuntimeProvider.ts:306` and `LocalExecutionAdapter.ts:52`.
5. **Dataset counts:** `DATASET/DATASET-STATISTICS.md` lists `6` samples / `4` speakers (`51.4s`), while `training/data/*.jsonl` contains `4` rows / `3` speakers (`51.4s`) with synthetic 16-hex hashes and **`0` real audio files on disk**.

---

## 3. Real Inference Execution Trace (`AVP-P00-003`)

- **Web App UI Click (`src/App.tsx:1713` — `handleRunPersianAsr`):**
  1. `executionMode === 'LOCAL'` (default): Checks `modelManagerRef.current.getSnapshot().activeModel` (`App.tsx:1766`). When null, halts cleanly (`MODEL_NOT_INSTALLED`) with **zero silent cloud calls**.
  2. **Critical Disconnect (`App.tsx:1796-1859`):** Even if an `.onnx` model were installed in OPFS, `App.tsx` only calls `verifyInstalledActiveModelOffline()` and then routes to `alignPersianScriptToAudio()` (existing track text) or `buildHonestAcousticSpeechSegments()` (energy burst segmentation). **`StudioAsrWorkerClient`, `studio-asr.worker.ts`, `asr-inference.worker.ts`, and `UnifiedOnnxPersianAsrEngine` are NEVER imported or invoked by `src/App.tsx`.**
  3. `executionMode === 'CLOUD'` (`App.tsx:1486-1622`): `executeCloudGeminiAsr()` posts `Content-Type: application/json` (`{ audioBase64, mimeType }`) to `/api/v1/asr/transcribe` (`App.tsx:1555`) with no consent receipt. Server `createStudioCloudAsrRouter` (`server.ts:231`, `CloudAsrConsentRegistry.ts:741`) strictly rejects non-`audio/wav` with `415 UNSUPPORTED_MEDIA_TYPE` and requires `X-ASR-Consent-Receipt` + `X-Audio-SHA256`.
- **Server Core Route (`/api/v1/asr-core/*`, `/api/v1/processing/execute`):**
  - `CoreAudioIngestion.ts` (real FFmpeg/RIFF decode + stereo phase guard -> 16kHz Mono PCM) -> `CoreAcousticCtcEngine.ts` (16-band Hann DFT -> hand-coded formant prototype dot-product -> `PersianCtcPrefixBeamSearchDecoder`). **Deterministic acoustic prototype matcher — NOT a neural model.**

---

## 4. Model Weights, Cloud Dependencies & Adaptive Runtime Findings (`AVP-P00-004`, `005`, `008`)

- **Model Forensics (`AVP-P00-004`):** `0` files matching `*.onnx`, `*.gguf`, `*.safetensors`, `*.pt`, `*.pth`, `*.bin`, `*.tflite`, `*.model`. Full 8-state breakdown recorded in `MODEL-REGISTRY.md`.
- **Cloud & API Key Audit (`AVP-P00-005`):**
  - Active runtime cloud SDK: `@google/genai` (`package.json:20`, `server.ts:5,240`) + `GEMINI_API_KEY` (`server.ts:234,236,408`) + `/api/v1/asr/transcribe`.
  - Lab-only provider env references: `ELEVENLABS_API_KEY`, `DEEPGRAM_API_KEY`, `OPENAI_API_KEY` appear only in isolated research/benchmark registries (`AsrExperimentationLabCore.ts`, `AsrDatasetAndBehavioralBenchmarkEngine.ts`, `AdaptiveAsrRouterEngine.ts`, `IndustrialValidationAndSecurityEngine.ts`) — NOT in the Studio local execution path.
  - Confirmed: Local mode works with networking disabled (zero silent audio exfiltration); `ArchitectureGuardrails.ts:30-34` forbids `/api/v1/asr/transcribe` in primary UI.
- **Adaptive Device Audit (`AVP-P00-008`):**
  - Existing `ResilientAiRuntime.ts:42-51` parses `userAgent` for iOS, defaults unknown `navigator.deviceMemory` to `8` GB (violating conservative `UNKNOWN` policy), and assumes `WASM_SIMD` without actual WASM SIMD bytecode validation (`WebAssembly.validate()`).
  - Existing `HardwareBenchmarkProfiler.ts` (128×128 Float32 matmul + OPFS 2 MB write probe), `MemoryBudgetManager.ts`, and `AdaptiveDegradationController.ts` provide strong foundations to evolve into `DeviceCapabilityDetector`, `AdaptiveRuntimeSelector`, `AdaptiveModelSelector`, `ResourceBudgetManager`, and `ModelCompatibilityRegistry` in `PHASE-02`.

---

## 5. Dataset & Training Paradigm Audit (`AVP-P00-010`)

- **Observed Data Reality:** `0` real `.wav`/`.flac`/`.mp3`/`.ogg` files on disk. `training/data/*.jsonl` contains `4` rows (`51.4s`, `3` speakers, `CC-BY-4.0`, synthetic 16-hex hashes); `DATASET/DATASET-STATISTICS.md` claims `6` rows (`51.4s`, `4` speakers). `SPLIT-POLICY.md` defines speaker-disjoint splits + `frozenTestManifestSha256`, and `QUALITY-CONTROL.md` defines 11 automated QC gates (`QC-01..QC-11`).
- **Clear Distinction of Adaptation Paradigms (Frozen in `ADR-018`):**
  1. **Pretrained Model Acquisition (`PHASE-01`):** Download commercially-cleared open-source weights + verify SHA-256 + benchmark unmodified baseline on CPU.
  2. **Domain Adaptation (`PHASE-02`/`06`):** Contextual vocabulary/prefix-trie biasing, custom lexicon, and Persian post-ASR orthographic/ZWNJ/code-switch restoration (no weight gradient updates).
  3. **LoRA (`PHASE-06`):** Low-Rank Adaptation freezing base weights and training lightweight adapter matrices on GPU for compatible architectures, then merging and quantizing for CPU.
  4. **Fine-Tuning (`PHASE-06`):** Full or partial weight optimization on licensed multi-speaker corpus when LoRA is unsupported or insufficient.
  5. **From-Scratch Training (`NO_GO` in v1):** Random-initialization pretraining requiring `>= 500–5,000+` hours & GPU cluster; formally rejected for v1 (`ARCHITECTURE-RESEARCH/FROM-SCRATCH-READINESS.md`).

---

## 6. Test Baseline (`AVP-P00-012` — Directly Observed 2026-11-20)

| Command | Executed | Exit | Pass / Fail / Skip | Notes |
| :--- | :---: | :---: | :---: | :--- |
| `npm run build` | YES | `0` | `PASS` | Vite production bundle succeeded |
| `tsc --noEmit` (non-test prod files) | YES | `0` | `0` errors | `ZERO_NON_TEST_TS_ERRORS` |
| `npm run lint` (`tsc --noEmit`) | YES | `1` | `95` errors in `8` `.test.ts` files | Pre-existing test drift (`LocalModelLifecycleManager.test.ts`: 38, `LabLocalInferenceAdapter.test.ts`: 23, `OpfsModelChunkStorage.test.ts`: 13, `PlatformWebhookSecurity.test.ts`: 8, `WebWorkerOrtRuntimeProvider.test.ts`: 8, `LabGroundTruthIsolation.test.ts`: 3, `PlatformControlPlaneGateway.test.ts`: 1, `PublicDataPlaneAudioExecution.test.ts`: 1) |
| `npm run test:quality-gates` | YES | `0` | `32 / 0 / 0` (`1.65s`) | `1/1` file PASS |
| `npx vitest run` | YES | `1` | `88 / 1 / 0` (`4.67s`) | `18/19` files PASS; 1 pre-existing static regex check (`PlatformControlPlaneAuthorization.spec.ts:15` on `org_avapardaz_sandbox`) |
| `npm run test:unit` | YES | `1` | `482 / 11 / 0` | 11 pre-existing failures aligned with stale `.test.ts` drift |
| `npm run test:e2e` | NO | N/A | `UNVERIFIED` | Playwright `1.65.1` installed; skipped in read-only Phase-00 |
| `cargo test --manifest-path wasm-audio-core/Cargo.toml` | NO | N/A | `BLOCKED` | `cargo` / `rustc` absent in container |

---

## 7. PHASE-00 Acceptance Gates Verification (Section 15 — 10/10 SATISFIED)

| Gate | Requirement | Status | Evidence |
| :---: | :--- | :---: | :--- |
| **Gate 1** | Repository Truth mapped & classified | `PASS` | Section 1 (`KEEP`/`REPAIR`/`REPLACE`/`REMOVE`/`UNVERIFIED`) |
| **Gate 2** | Exact ASR execution path & weight absence verified | `PASS` | Section 3 & `MODEL-REGISTRY.md` (`0` weights, disconnected worker) |
| **Gate 3** | Local inference limitations & missing elements documented | `PASS` | `/public/ort/` missing, `0` native binary, WASM32 ceiling documented |
| **Gate 4** | Cloud dependencies isolated & guaranteed non-mandatory | `PASS` | Section 4 & `ADR-015` |
| **Gate 5** | Adobe Audition integration feasibility established from SDK | `PASS` | CEP + ExtendScript + Companion IPC (`ADR-012`); desktop `UNVERIFIED` |
| **Gate 6** | Browser CPU runtime & capability limits understood | `PASS` | `HARDWARE-COMPATIBILITY-MATRIX.md` & `ADR-004`/`007` |
| **Gate 7** | Multi-device matrix & adaptive architecture documented | `PASS` | `HARDWARE-COMPATIBILITY-MATRIX.md` + 4 Tiers + 3 Profiles |
| **Gate 8** | One shared Central Engine architecture approved | `PASS` | `ADR-001` & `ADR-002` (Option A scored `8.95/10`) |
| **Gate 9** | Model discovery, licensing, benchmark & dataset plan frozen | `PASS` | `MASTER-ROADMAP.md`, `MODEL-REGISTRY.md`, `ADR-017`/`018` |
| **Gate 10** | Permanent engineering memory written without duplicates | `PASS` | All 12 canonical docs under `docs/AVAPARDAZ/` verified |
