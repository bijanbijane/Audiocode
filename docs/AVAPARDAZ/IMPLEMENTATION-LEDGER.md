# AVAPARDAZ — IMPLEMENTATION LEDGER (AUTHORITATIVE TASK LEDGER)

**Document ID:** `AVP-IMPL-LEDGER-3.1`  
**Supersedes:** `AVP-IMPL-LEDGER-3.0` (updated for `MASTER v3.1` phase order per `AVP-ADR-PHASE-ORDER-001`)  
**Last Updated:** `2026-11-20`  
**Status Vocabulary:** `NOT_STARTED` | `IN_PROGRESS` | `BLOCKED` | `IMPLEMENTED` | `VERIFIED` | `ACCEPTED`  
**Anti-Repetition Rule:** Tasks marked `ACCEPTED` MUST NOT be re-executed unless invalidated by regression, code/dependency changes, or explicit re-audit.

---

## 1. PHASE-00 — Reality Audit & Architecture Freeze (`ACCEPTED`)

| Task ID | Task Title | Status | Direct Evidence | Date |
| :--- | :--- | :---: | :--- | :---: |
| `AVP-P00-001` | Repository and Git Reality | `ACCEPTED` | Inspected `/app/applet`, verified `.git` absent, `package.json`, Node `v22.23.2`, 4 vCPUs / 12 GiB RAM, `ffmpeg`, no GPU/`pip3`/`cargo` | 2026-11-20 |
| `AVP-P00-002` | Existing ASR Architecture Audit | `ACCEPTED` | Audited all ASR/runtime/audio/worker subsystems; classified `KEEP`/`REPAIR`/`REPLACE`/`REMOVE`/`UNVERIFIED` | 2026-11-20 |
| `AVP-P00-003` | Real Inference Execution Trace | `ACCEPTED` | Traced `App.tsx`, `server.ts`, `CoreAcousticCtcEngine.ts`, `CoreModelRouter.ts`, `LocalExecutionAdapter.ts` | 2026-11-20 |
| `AVP-P00-004` | Model Weight & Runtime Forensics | `ACCEPTED` | Verified `0` weight files on disk & `onnxruntime-web@1.31.1` + 4 `.wasm` files in `node_modules` | 2026-11-20 |
| `AVP-P00-005` | Cloud & Network Dependency Audit | `ACCEPTED` | Audited `@google/genai`, `/api/v1/asr/transcribe`, `CloudAsrConsentRegistry`, and network boundaries | 2026-11-20 |
| `AVP-P00-006` | Existing Adobe Integration Audit | `ACCEPTED` | Audited `AuditionHostAdapter.ts`, `CompanionIpcBridge.ts`, `CanonicalProjectService.ts`; verified `0` CEP files | 2026-11-20 |
| `AVP-P00-007` | Cross-Platform Hardware Matrix | `ACCEPTED` | Created `HARDWARE-COMPATIBILITY-MATRIX.md` | 2026-11-20 |
| `AVP-P00-008` | Adaptive Device Architecture | `ACCEPTED` | Standardized `TIER-0..3` & `AVP_MODEL_LITE`/`BALANCED`/`QUALITY` (`ADR-007`/`ADR-008`) | 2026-11-20 |
| `AVP-P00-009` | Architecture Alternatives (Weighted Scoring) | `ACCEPTED` | Froze Option A (`8.75/10`) in `ADR-001`/`ADR-002` | 2026-11-20 |
| `AVP-P00-010` | Dataset & Training Audit | `ACCEPTED` | Verified `0` real audio files on disk & reconciled dataset doc contradictions | 2026-11-20 |
| `AVP-P00-011` | Security & Privacy Audit | `ACCEPTED` | Defined local-only, loopback HMAC IPC, SHA-256 verification (`ADR-015`) | 2026-11-20 |
| `AVP-P00-012` | Test Baseline | `ACCEPTED` | Recorded exact Phase-00 baseline (`test:unit` 482/493, `vitest` 88/89, `quality-gates` 32/32, `build` PASS) | 2026-11-20 |

---

## 2. PHASE-01 — Local Runtime Foundation & Memory-Safe Audio Pipeline (`ACCEPTED` — `MASTER v3.1`)

| Task ID | Task Title | Status | Direct Evidence | Date |
| :--- | :--- | :---: | :--- | :---: |
| `AVP-P01-001-BASELINE` | Phase-01 Entry Gate & Roadmap v3.1 Alignment | `ACCEPTED` | Verified `PHASE-00 == ACCEPTED`; logged `AVP-ADR-PHASE-ORDER-001` in `DECISION-LOG.md` & `MASTER-ROADMAP.md` v3.1 | 2026-11-20 |
| `AVP-P01-002` | Memory Budget Manager Hardening (`1,024 MiB` cap, duplicate ID guard, owner cleanup, leak detection) | `ACCEPTED` | Updated `src/runtime/memory/MemoryBudgetManager.ts` + `MemoryBudgetManager.test.ts` (`MT-01`..`MT-14` PASS); `MEMORY-BUDGET-IMPLEMENTATION.md` | 2026-11-20 |
| `AVP-P01-003` | OPFS Storage & Bounded Fallback (`32 MiB`) + Pool-Aware Quota | `ACCEPTED` | Updated `src/engine/storageBroker.ts` (`MAX_OPFS_UNAVAILABLE_FALLBACK_BYTES`, `estimateStorageQuotaForIngest`); verified via `storageBroker.test.ts`, `streamingIngest.memory.test.ts`, `AudioImportCoordinator.test.ts` (`20/20` PASS); `STORAGE-IMPLEMENTATION-REPORT.md` | 2026-11-20 |
| `AVP-P01-004` | Streaming Ingest Guard & Numerically Verified Chunked Resampling | `ACCEPTED` | Updated `src/App.tsx` (`retainActivePcmMirror <= 24 MiB`, OPFS ready flow) + expanded `src/engine/resampler.test.ts` (`48/44.1/32 kHz` drift `<= 1`, RMS `< 1e-3`, max `< 5e-3`); `STREAMING-INGEST-IMPLEMENTATION.md` | 2026-11-20 |
| `AVP-P01-005` | Block-Backed Windowed Playback & Streaming WAV Export | `ACCEPTED` | Updated `src/engine/audioPlayback.ts` (`renderTimelineRangeFromBlocks`, `streamExportTimelineToWav`, `MAX_LEGACY_FULL_RENDER_BYTES = 128 MiB`, async windowed transport wired into `App.tsx`) + `streamingPlaybackExport.test.ts` PASS | 2026-11-20 |
| `AVP-P01-006` | Zero Cloud ASR (`HTTP 410 Gone`) & Zero Fake Transcripts | `ACCEPTED` | Created `src/runtime/LocalExecutionPolicy.ts`; decommissioned `@google/genai` & cloud route in `server.ts`; removed cloud ASR & startup health fetch from `src/App.tsx`; verified via `LocalOnlyExecutionPolicy.test.ts`, `AsrNetworkIsolation.test.ts`, live `curl` `410`, Playwright `0` API calls / `0` console errors; `LOCAL-ONLY-VERIFICATION.md` | 2026-11-20 |
| `AVP-P01-007` | Cross-Platform Capability Prober & Resource Policy (`TIER-0..3`) | `ACCEPTED` | Created `src/runtime/CrossPlatformResourcePolicy.ts` + `CrossPlatformResourcePolicy.test.ts` PASS (OS/arch/browser, real WASM SIMD probe, `'UNKNOWN'` honesty, 6-step local-only degradation) | 2026-11-20 |
| `AVP-P01-008` | 30/60/120-Minute Long-File Stress Suite & Phase-01 Acceptance | `ACCEPTED` | Created `src/engine/longFileStress.test.ts` (`6/6` PASS, `0 B` leaked, cache `<= 23.93 MiB`, 120m stereo RSS `507.34 MiB`); `LONG-FILE-STRESS-REPORT.md` & `PHASE-01-ACCEPTANCE-REPORT.md` (`8/8` Gates PASS) | 2026-11-20 |

---

## 3. PHASE-02 — Open-Source Model Discovery & Multi-Device CPU Benchmark (`ACCEPTED`)

| Task ID | Task Title | Status | Direct Evidence | Date |
| :--- | :--- | :---: | :--- | :---: |
| `AVP-P02-001` | Upstream License, Model Card & Commercial Rights Audit | `ACCEPTED` | `PHASE-02-LICENSE-AUDIT.md`, `PHASE-14-COMMERCIAL-READINESS.md` (`Apache-2.0`/`MIT` cleared; `CC-BY-NC` rejected) | 2026-11-20 |
| `AVP-P02-002` | Acquire Legally Licensed Real Evaluation Audio Set (`25` FLEURS `dev` WAVs, `277.33s`) | `ACCEPTED` | `benchmarks/phase02/prepare_fleurs_dev_eval.py` (`10` FA, `10` EN, `5` FA-EN concat, `CC-BY-4.0`, zero WAVs in repo) | 2026-11-20 |
| `AVP-P02-003` | Prepare Offline Native CPU Runtime & SHA-256 Model Provenance | `ACCEPTED` | `sherpa-onnx v2.0.2` + `MODEL-PROVENANCE.md` (exact byte lengths & SHA-256 for 5 ONNX models + 4 WASM files) | 2026-11-20 |
| `AVP-P02-004` | Execute Reproducible 5-Model Offline CPU Bake-Off + Paired Bootstrap 95% CIs | `ACCEPTED` | `benchmarks/phase02/results-2026-11-20.json` (`90,250 B`, `25/25` `rc=0` per model); `test_evaluation_metrics.py` `6/6` PASS | 2026-11-20 |
| `AVP-P02-005` | Assign `AVP_MODEL_LITE` / `BALANCED` / `QUALITY` & Issue Phase-02 Acceptance | `ACCEPTED` | `MODEL-SELECTION-REPORT.md`, `MODEL-REGISTRY.md`, `PHASE-02-ACCEPTANCE-REPORT.md`, `ADR-023` | 2026-11-20 |

---

## 4. PHASE-08..15 — CPU Optimization, Shared Companion, Audition CEP, Web App, Security & Final Acceptance

| Task ID | Task Title | Status | Direct Evidence / Exact Blocker | Date |
| :--- | :--- | :---: | :--- | :---: |
| `AVP-P08-001` | Local Neural CPU Engine, Quantization Audit & `O(1)` 60-Min Streaming Pipeline | `VERIFIED` *(Linux CPU)* | `LocalSherpaNeuralEngine.ts`, `LongAudioChunkedPipeline.ts`, `subtitleExporter.ts`, `PHASE-08-QUANTIZATION-REPORT.md` (`ADR-024`), `10s..60m` stress PASS | 2026-11-20 |
| `AVP-P09-001` | Shared Local Companion IPC (`v2.0.0`) & Adobe Audition CEP Plugin Package | `IMPLEMENTED` *(Host GUI `BLOCKED`)* | `LocalCompanionService.ts`, `companion/avapardaz-companion.ts`, `packages/audition-cep-plugin/`, `dist-packages/avapardaz-audition-cep-v1.0.0.tar.gz` (`11,369 B`, SHA-256 verified) | 2026-11-20 |
| `AVP-P10-001` | Web App Shared Local Companion Integration (`App.tsx` + `server.ts`) | `VERIFIED` | Mounted `/api/v2/companion`; `CompanionWebClient.ts` wired into `App.tsx` with fail-closed local-only policy; `vite build` PASS | 2026-11-20 |
| `AVP-P12-001` | Security Red-Team Penetration & Privacy Verification | `VERIFIED` *(`npm audit` `ENOLOCK`)* | `LocalCompanionAndSecurity.test.ts` (`7/7` PASS: DNS rebinding, Origin CSRF, HMAC/nonce replay, path traversal, corrupt WAV, real offline ASR); `0` secrets; `PHASE-12-SECURITY-DECISION.md` | 2026-11-20 |
| `AVP-P14-001` | Commercial License Compliance & Offline Licensing Readiness | `BLOCKED` *(Payments/Signing)* | Commercial licenses cleared (`Apache-2.0`/`MIT`); Ed25519 offline licensing in `PlatformLicenseService.ts`; blocked on payment gateway, signing certs & CDN | 2026-11-20 |
| `AVP-P15-001` | Final Independent 10-Gate Product Acceptance & Roadmap Termination | `ACCEPTED (VERDICT ISSUED)` | `PHASE-15-FINAL-ACCEPTANCE-DECISION.md` (`ADR-026`): **`BLOCKED`** (Public Commercial Release) / **`READY WITH RESTRICTIONS`** (Internal Linux Technical Alpha) | 2026-11-20 |

