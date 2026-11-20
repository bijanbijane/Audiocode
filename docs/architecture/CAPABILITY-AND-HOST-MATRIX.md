# AVAPARDAZ — CAPABILITY OWNERSHIP, HOST INTEGRATION & ARCHITECTURAL DEBT MATRIX

**Policy Reference:** `AVP-ARCH-001` (Version 4.0 — Permanent Architectural Constitution)  
**Last Verified (UTC):** `2026-11-19`  
**Contract Version:** `2.0.0` (`CanonicalOperationEnvelope` / `CanonicalOperationResult`)

---

## 1. Feature Ownership & Cross-Interface Capability Matrix (Section 12)

| Capability ID | Ownership Category | Authoritative Backend Module | Contract Ver | Local Status | Cloud Status | Web UI Status | Audition Plugin / Companion IPC Status | Verification Evidence |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| `speech.transcription` | Shared Processing Capability | `src/processing-engine/capabilities/CapabilityRegistry.ts` -> `UnifiedProcessingOrchestrator` -> `src/asr-core/` | `2.0.0` | `AVAILABLE_NOW` (CPU CTC Baseline; Neural weights optional) | `INSTALLED_NOT_CONFIGURED` | Available (Demo/Studio) | Companion IPC `/api/v2/companion/ipc` (`VERIFIED_CONTRACT_AND_SCHEMA`) | `avapardazBackendV2.test.ts`, `coreAsrEngine.test.ts` |
| `audio.silence_detection` | Shared Processing Capability | `CapabilityRegistry.ts` -> `SpeechEventEngine` (`SilenceAndPauseAnalyzer`) | `2.0.0` | `AVAILABLE_NOW` | `INSTALLED_NOT_CONFIGURED` | Available | Companion IPC (`VERIFIED_CONTRACT_AND_SCHEMA`) | `avapardazBackendV2.test.ts` |
| `speech.filler_detection` | Shared Processing Capability | `CapabilityRegistry.ts` -> `SpeechEventEngine` (`PersianDisfluencyEngine`) | `2.0.0` | `AVAILABLE_NOW` | `INSTALLED_NOT_CONFIGURED` | Available | Companion IPC (`VERIFIED_CONTRACT_AND_SCHEMA`) | `avapardazBackendV2.test.ts` |
| `speech.repetition_detection` | Shared Processing Capability | `CapabilityRegistry.ts` -> `SpeechEventEngine` (`PersianSemanticRepetitionEngine`) | `2.0.0` | `AVAILABLE_NOW` | `INSTALLED_NOT_CONFIGURED` | Available | Companion IPC (`VERIFIED_CONTRACT_AND_SCHEMA`) | `avapardazBackendV2.test.ts` |
| `speech.intelligent_editing` | Shared Processing Capability | `CapabilityRegistry.ts` -> `EditDecisionEngine` (Non-destructive EDL) | `2.0.0` | `AVAILABLE_NOW` | `INSTALLED_NOT_CONFIGURED` | Available | Companion IPC + Canonical Project EditPlan (`VERIFIED_CONTRACT_AND_SCHEMA`) | `avapardazBackendV2.test.ts` |
| `audio.quality_analysis` | Shared Processing Capability | `CapabilityRegistry.ts` -> `CoreAudioIngestion` (Signal Health & Stereo Phase) | `2.0.0` | `AVAILABLE_NOW` | `INSTALLED_NOT_CONFIGURED` | Available | Companion IPC (`VERIFIED_CONTRACT_AND_SCHEMA`) | `avapardazBackendV2.test.ts` |
| `projects.edit_plan_commit` | Application Workflow | `src/host-bridge/CanonicalProjectService.ts` | `2.0.0` | `AVAILABLE_NOW` | N/A (Local-First) | Supporting | Stale-revision `409` guard + non-destructive rollback verified | `avapardazBackendV2.test.ts` |
| `audition.sesx_interchange` | Host Integration Capability | `src/host-bridge/audition/AuditionHostAdapter.ts` | `1.0.0` | `VERIFIED_CONTRACT_AND_SCHEMA` | N/A | N/A | XML + sample-bounds verified; **desktop Audition load UNVERIFIED on Linux** | `avapardazBackendV2.test.ts` |
| `commercial.auth_licensing` | Commercial Capability | `backend/src/BackendAuthAndPaymentService.ts`, `PlatformLicenseService.ts` | `1.0.0` | Offline Ed25519 lease verification | PostgreSQL/Fastify | Portal | Strictly isolated from Processing Core (Section 15.3) | `BackendAuthAndPaymentService.test.ts` |

---

## 2. Adobe Audition Host Compatibility Matrix (Sections 9.2 & 16.3)

| Component / Target | Supported / Target Versions | Verification Status (`[Observed Fact]`) | Known Limitations |
| :--- | :--- | :--- | :--- |
| **Operating Systems (Host)** | macOS 13+ (Apple Silicon / Intel), Windows 10/11 x64 | **UNVERIFIED_REQUIRES_AUDITION_HOST** (Linux container cannot launch Adobe Audition) | Desktop Audition binary & CEP runtime must be tested on macOS/Windows target machines. |
| **Adobe Audition Host** | Target `>= 23.0` (SESX) / `>= 24.0` (CEP Panel) | **UNVERIFIED_REQUIRES_AUDITION_HOST** | Direct multitrack clip-split ExtendScript APIs are restricted; non-destructive SESX interchange is the safe fallback. |
| **Companion IPC Bridge** | Protocol `1.0.0` (`MIN_PANEL_MAJOR=1`, `MIN_ADAPTER_MAJOR=1`) | **VERIFIED** (Node.js Linux Express loopback) | Enforces `127.0.0.1`/`::1` loopback-only, version handshake, HMAC-SHA256 session tokens, and nonce replay rejection. |
| **Processing Contract** | `2.0.0` (`CanonicalOperationEnvelope`) | **VERIFIED** | Strictly serializable JSON; zero Buffer/File/DOM/Adobe objects in wire schema. |
| **Optional Native VST3/AU** | Planned separate component (Section 8.4) | **UNVERIFIED / NOT BUILT** | Requires Xcode / MSVC / Cargo desktop toolchain. |

---

## 3. Architectural Debt Register & Incremental Migration Plan (Section 0.2 & 17.1)

1. **`DEBT-001` Web Studio Orchestration in `src/App.tsx` (Legacy Web-First State):**
   - *Observed State:* `src/App.tsx` holds rich interactive demo/studio state directly in React hooks for the browser preview.
   - *Classification:* Architectural Debt (permitted as Web Demonstration Capability under Section 1 & 12, NOT the authoritative backend for plugin workflows).
   - *Migration Path:* All plugin/companion workflows consume `/api/v2/*` (`CapabilityRegistry`, `ProcessingJobManager`, `CanonicalProjectService`) directly with zero dependency on `src/App.tsx` or browser lifecycle.
2. **`DEBT-002` Legacy `/api/v1/*` Routes in `server.ts`:**
   - *Observed State:* Existing `/api/v1/asr/*`, `/api/v1/processing/*`, and sandbox endpoints remain active for backwards compatibility with existing studio modals and tests.
   - *Migration Path:* Kept non-breaking while `/api/v2/*` becomes the canonical Plugin-First backend interface; both share the exact same `UnifiedProcessingOrchestrator` instance (`INV-003`).
3. **`DEBT-003` In-Memory Job & Project Store in Local Dev Mode:**
   - *Observed State:* `ProcessingJobManager` and `CanonicalProjectService` run cleanly in-process without requiring an external PostgreSQL daemon during local development.
   - *Migration Path:* Introduce durable SQLite/PostgreSQL persistence adapter behind the same service boundary when packaging the desktop Companion binary or Cloud cluster.
4. **`DEBT-004` Real Desktop Adobe Audition Verification (Section 16.2):**
   - *Observed State:* Cannot execute Adobe Audition GUI or CEP host inside a headless Linux container.
   - *Migration Path:* Package CEP panel manifest + ExtendScript bridge on macOS/Windows and run end-to-end Section 17.2 vertical integration proof against Adobe Audition 24.x.
