# AVAPARDAZ — PRODUCT INTEGRATION STATUS

**Document ID:** `AVP-PRODUCT-STATUS-2.0`  
**Last Audited:** 2026-11-20 (`PHASE-00`)

---

## 1. Product Priority Matrix

| Product | Priority | Target Runtime | Current Reality (`PHASE-00`) | Target Phase |
| :--- | :---: | :--- | :--- | :---: |
| **Product A: Adobe Audition Plugin** | **#1 (Primary)** | Native CPU via Local Companion IPC + CEP Extension | **Contract-only / Unverified on Desktop.** `AuditionHostAdapter.ts` (SESX v1.9 exporter/validator) and `CompanionIpcBridge.ts` (HMAC loopback IPC) exist, but `AvapardazBackendRouter.ts` is NOT mounted in `server.ts`, zero CEP (`CSXS/manifest.xml`, `.jsx`, `.zxp`) files exist, and zero native neural inference runtime exists. | `PHASE-03` & `PHASE-04` |
| **Product B: Web Application** | **#2 (Secondary)** | Browser Web Worker + `onnxruntime-web` (WASM SIMD) + OPFS | **UI Shell & Non-Destructive Audio Editor Live; Neural Local ASR Disconnected.** `App.tsx` renders cleanly on port `3000`, `onnxruntime-web@1.31.1` is installed in `package.json`, and worker/OPFS scaffolding (`studio-asr.worker.ts`, `StudioAsrWorkerClient.ts`, `WebWorkerOrtRuntimeProvider.ts`) exists — but `App.tsx` never imports/invokes `StudioAsrWorkerClient`, `/public/ort/` is missing, `0` `.onnx` weights exist, and explicit Cloud mode in `App.tsx:1555` mismatches server `audio/wav` + consent-receipt contract. | `PHASE-05` |

---

## 2. Shared Core vs Product Adapter Wiring Matrix

| Capability Layer | Shared Core Module(s) | Adobe Audition Plugin Status | Web Application Status |
| :--- | :--- | :---: | :---: |
| **Canonical Contracts & Error Taxonomy** | `src/asr-core/CoreAsrContracts.ts`, `src/processing-engine/UnifiedProcessingContract.ts` | `IMPLEMENTED` (partial; needs `PHASE-02` unification) | `IMPLEMENTED` (partial; needs `PHASE-02` unification) |
| **Audio Ingestion & Stereo Phase Guard** | `src/asr-core/CoreAudioIngestion.ts`, `src/engine/resampler.ts` | `IMPLEMENTED` (Node FFmpeg/RIFF path verified in tests) | `IMPLEMENTED` (in-memory WebAudio/Sinc path; needs chunked OPFS wiring) |
| **Persian Linguistics & Normalization** | `src/persian-linguistics/*`, `src/asr-core/CoreNormalizationAndLanguage.ts`, `src/ai-engine/PersianTextNormalizer.ts` | `IMPLEMENTED` (shared TS) | `IMPLEMENTED` (shared TS) |
| **Model Lifecycle & SHA-256 Verification** | `src/lifecycle/LocalModelLifecycleManager.ts`, `src/lifecycle/OpfsModelChunkStorage.ts`, `src/ai-engine/asr/WebWorkerOrtRuntimeProvider.ts` | `NOT_STARTED` (needs native disk model store) | `IMPLEMENTED` (code exists; `0` real weights verified; stale unit tests need repair) |
| **Genuine Neural Inference Execution** | Planned `AsrRuntimeAdapter` (`PHASE-02`) | `NOT_STARTED` (no native `whisper.cpp`/ORT binary) | `NOT_STARTED` (`StudioAsrWorkerClient` not wired to `App.tsx`; `/public/ort/` absent; `0` weights) |
| **Companion Loopback HMAC IPC** | `src/host-bridge/companion/CompanionIpcBridge.ts` | `IMPLEMENTED` (unit-tested class; **NOT mounted in `server.ts`**) | `N/A` (Web uses Worker RPC) |
| **CEP Panel & ExtendScript Host Bridge** | None yet (`0` `manifest.xml` / `.jsx` / `.zxp`) | `NOT_STARTED` (`UNVERIFIED` — requires macOS/Windows desktop Audition) | `N/A` |
| **Non-Destructive SESX v1.9 Interchange** | `src/host-bridge/audition/AuditionHostAdapter.ts`, `src/host-bridge/CanonicalProjectService.ts` | `VERIFIED` (XML structure/bounds only; desktop Audition open is `UNVERIFIED`) | `N/A` |
| **Transcript Export (`TXT/SRT/VTT/JSON/TextGrid`)** | `src/engine/persianAsrTranscriber.ts`, `src/ai-engine/asr/PraatTextGridAndLinguisticExporter.ts` | `NOT_STARTED` (needs panel wiring) | `IMPLEMENTED` |
| **Offline PWA Shell & Cross-Origin Isolation** | `public/sw.js`, `server.ts:142-146`, `index.html` | `N/A` | `VERIFIED` (`COOP: same-origin`, `COEP: credentialless`, zero CDN links) |

---

## 3. Adobe Audition Host Capability Verification Table (Honest Linux-Container Classification)

Per Master Directive Section 4A & Task 00.7, NO Adobe Audition desktop capability may be claimed verified from a headless Linux container:

| Capability | Integration Path | Status in `PHASE-00` | Evidence / Constraint |
| :--- | :--- | :---: | :--- |
| Active Document / Session Metadata Read | CEP + ExtendScript `.jsx` | `UNVERIFIED` | Requires desktop Adobe Audition (macOS/Windows); `.jsx` bridge does not exist yet |
| Audio Buffer / Selection Range Access | CEP + ExtendScript -> Companion IPC | `UNVERIFIED` | Requires desktop Audition Host API testing |
| Playhead & Text-Selection Sync | CEP + ExtendScript | `UNVERIFIED` | Subject to Audition ExtendScript API limits |
| Direct Marker / Cue Creation & Timeline Writeback | ExtendScript / SESX v1.9 fallback | `UNVERIFIED` | Audition ExtendScript has restricted multitrack APIs; SESX XML export is contract-verified only |
| Companion Loopback HMAC Handshake & Nonce Replay Guard | `CompanionIpcBridge.ts` | `VERIFIED` (Contract only) | Code verified; not yet mounted on live Companion process |
| CEP Manifest (`CSXS/manifest.xml`) & `.zxp` Packaging | Adobe CEP SDK | `NOT_STARTED` | Zero CEP extension files exist in repo |
| VST3 / AU Real-Time Audio Effect | Steinberg VST3 SDK | `DEFERRED` | Explicitly separated from CEP transcription panel (ADR-004) |
