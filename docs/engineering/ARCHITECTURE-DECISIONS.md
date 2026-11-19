# Architecture Decision Records (ADRs)

## ADR-001: Canonical Runtime Consolidation (`/server.ts` Express vs `/backend/src/server.ts` Fastify)
- **Status:** `ACCEPTED`
- **Context:** The repository contains two server entrypoints:
  1. `/server.ts` (Express 4.21 + Vite middlewares on port `3000`) serving the React DAW UI, `/api/v1/*` benchmark/ASR/streaming APIs, `/v1/*` commercial platform APIs, and Phase 11 speech intelligence endpoints.
  2. `/backend/src/server.ts` (Fastify + `pg`) paired with `/backend/Dockerfile`, which references missing packages (`fastify`, `pg`) in root `/package.json` and assumes `npm run build` compiles TS server output into `dist/server.js` (whereas root `package.json` runs `vite build`).
- **Decision:**
  - Designate `/server.ts` as the **single active Control & Data Plane runtime** for `PRIVATE_ALPHA` and container previews.
  - Reuse pure domain modules inside `/backend/src/*` (`EnterpriseApiKeyAndQuotaManager`, `BackendBillingInvoiceAndUsageLedger`, `BackendModelCanaryRolloutService`, etc.) only where imported explicitly; do **not** run `/backend/Dockerfile` in production until a dedicated `tsconfig.backend.json` + standalone backend manifest exists.
- **Consequences:** Eliminates ambiguity in deployment targets, prevents broken Docker builds, and aligns Vitest specs with real runtime endpoints.

---

## ADR-002: Canonical Database Schema & Migration Authority (`/platform/migrations/`)
- **Status:** `ACCEPTED`
- **Context:** DDL statements are scattered across `/platform/migrations/0001_phase10_commercial_postgres.sql`, `/platform/migrations/0002_phase11_speech_intelligence.sql`, `/backend/db/schema.sql + migration_002..007.sql`, and markdown specs (`/ENGINEERING/DATABASE-SCHEMA.md`).
- **Decision:**
  - Designate `/platform/migrations/` as the **sole canonical schema sequence** (`0001`, `0002`, and future `0003+`).
  - Reconcile benchmark/streaming/Ed25519 licensing tables from `/backend/db/` and `/ENGINEERING/DATABASE-SCHEMA.md` into `/platform/migrations/0003_*` during `M-P0-02` before binding `DATABASE_URL`.
- **Consequences:** Single forward-only migration graph; zero schema drift when provisioning PostgreSQL 16+.

---

## ADR-003: Honest Local Acoustic / Post-Processing Boundary vs GPU Neural Worker
- **Status:** `ACCEPTED`
- **Context:** Container `G0_CPU_ONLY` has 0 CUDA GPUs, no `pip`/`pytorch`, no `onnxruntime-node`, and zero `.onnx`/`.safetensors`/`.pt` weights on disk.
- **Decision:**
  - Never mask corpus lookup, deterministic heuristics, or post-processing as blind neural acoustic decoding.
  - Neural models (`qwen3-asr-1.7b-fa`, `whisper-large-v3-fa`) MUST fail closed (`503 PROVIDER_UNAVAILABLE`) unless `ASR_GPU_WORKER_URL` or verified local ONNX runtime + weights are present.
  - Maintain clear separation between Layer-1 `ASR_HYPOTHESIS` (`immutable: true`) and deterministic DSP/CTC alignment/normalization enhancements.
- **Consequences:** Preserves epistemic honesty in benchmarks, customer expectations, and SLA reporting.

---

## ADR-004: Phase 7 Research Track Isolation (`BELOW_D0 NO_GO`)
- **Status:** `ACCEPTED`
- **Context:** Disk corpus holds `6` samples (`51.4s` / `0.0143h`), far below `D0` (`30h`) and `D1` (`500h`).
- **Decision:**
  - Isolate Track B/C from-scratch model research (`RES-01`) from the production delivery critical path (`P0 -> P4`).
  - Hard-lock `BELOW_D0 NO_GO` inside `AdvancedModelResearchAndArchitectureEngine` until verified `>= 500h` speaker-disjoint data (`D1`) and multi-GPU budget are explicitly approved.
- **Consequences:** Prevents wasted engineering and compute spend while keeping hybrid open-model adaptation (`M01..M05` LoRA + CTC/Trie/ROVER) unblocked once `D0` + GPU exist.

---

## ADR-005: Dual Persian Orthographic Normalization vs ZWNJ-Tolerant WER
- **Status:** `ACCEPTED`
- **Context:** `PersianTextNormalizer` converts Arabic Yeh/Kaf and spaced prefixes (`می کنم`) to standard ZWNJ (`می‌کنم`) for immutable display/editing fidelity. However, joined tokens (`میکنیم` vs `می‌کنیم`) are pure half-space orthographic differences that caused `AutomatedQualityGateRunner.computePersianWER` to report `11.11%` normalized WER on lexically identical Persian sentences.
- **Decision:**
  - Preserve `\u200c` inside `PersianTextNormalizer.normalize()` / `normalizeTokenText()` so editorial UI, Layer-2 normalized text, and `FA-STRICT-V1` orthographic gates retain proper Persian typography.
  - Strip optional `\u200c` inside `AutomatedQualityGateRunner.computePersianWER()` exclusively when computing `normalizedWerPercent`, while keeping `rawWerPercent` strict against missing ZWNJ and Arabic characters.
- **Consequences:** `EditQualityVsModelQualityEvaluator` accurately separates acoustic/lexical errors from harmless ZWNJ concatenation differences without degrading UI typography.

---

## ADR-006: Single Unified Processing Engine with Explicit `LOCAL` and `CLOUD` Execution Paths
- **Status:** `ACCEPTED`
- **Context:** Supporting optional cloud processing must not duplicate ASR/validation/normalization business logic or silently transmit user audio to remote endpoints.
- **Decision:**
  - Establish a single orchestrator (`src/processing-engine/UnifiedProcessingOrchestrator.ts`) enforcing one versioned contract (`UnifiedProcessingContract.ts`) across interchangeable `LocalExecutionAdapter` and `CloudExecutionAdapter` paths.
  - Default strictly to `LOCAL` with explicit user opt-in (`ExecutionModePreferenceStore`) and fail-closed cloud consent/configuration checks.
- **Consequences:** Identical schema, provenance, and normalization semantics across local and cloud execution without silent remote transmission.

---

## ADR-007: Centralized Fail-Closed Server-Side RBAC & Provenance (`AuthorizationPolicyEngine`)
- **Status:** `ACCEPTED`
- **Context:** Legacy gateway helpers (`SpeechSecurityGateway.resolveRole()` and `ModelFactoryGateway.resolveActorRole()`) fell back to `OWNER` on missing/invalid roles and accepted caller-supplied `x-avapardaz-role` headers.
- **Decision:**
  - Eliminate all client-supplied role fallbacks and HTTP header role pass-throughs in `server.ts`, `SpeechSecurityGateway.ts`, and `ModelFactoryGateway.ts`.
  - Route all Security and Model Factory operations through `src/security/AuthorizationPolicyEngine.ts`, deriving principal identity and verified membership strictly from `PlatformControlPlaneService` with independent least-privilege scope verification and tenant-ownership checks prior to mutation.
- **Consequences:** Eliminates privilege escalation, forged governance provenance, and cross-tenant mutations while keeping a single shared authorization engine.

---

## ADR-008: Race-Free Project Session Locking & Verified Recovery Checkpoints
- **Status:** `ACCEPTED`
- **Context:** `CrashRecoveryAndSessionLock` previously returned `true` when `navigator.locks` was absent, used `Math.random()` session IDs, built OPFS filenames directly from `projectId`, and blindly trusted `JSON.parse()` recovery payloads.
- **Decision:**
  - Use cryptographically generated session IDs, primary Web Locks with race-free same-tab ref-counting, atomic IndexedDB compare-and-set lease fallback with monotonic fencing tokens, and fail-closed `LOCK_UNAVAILABLE` when no exclusive backend exists.
  - Persist versioned checkpoints (`envelopeVersion: 2`) with canonical SHA-256 digests, injective hex storage keys, deep runtime `ProjectDocument` schema validation, safe migration, per-project serialized interruption-safe writes, and explicit conflict/media verification before restore.
- **Consequences:** Concurrent tabs cannot silently corrupt projects, interrupted writes preserve the last valid checkpoint, and corrupted/incompatible recovery files are surfaced explicitly without silent data loss.

