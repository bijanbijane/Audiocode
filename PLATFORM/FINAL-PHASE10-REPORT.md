# PHASE 10 — FINAL DELIVERY REPORT (SECTION 35)

## A. Product Status
- **Product Stage:** Engineering Private Alpha (`PRIVATE_ALPHA`, Non-Commercial Sandbox)
- **Public API Version:** `/v1` (OpenAPI 3.1 documented in `/PLATFORM/OPENAPI-V1.yaml`)
- **Active Models in Container (`G0_CPU_ONLY`):** `asr-fa-en-v1` (STABLE local), `asr-fa-en-baseline` (BETA local); `qwen3-asr-1.7b-fa` & `whisper-large-v3-fa` gated (`503 PROVIDER_UNAVAILABLE` until GPU attached)
- **Supported Languages:** Persian (`fa`), English (`en`), Persian-English Code-Switching (`fa-en`)
- **Supported Execution Modes:** `batch`, `native_streaming` (`ASR1`), `long_form_async`

## B. Identity and Multi-Tenancy
- **Seeded Sandbox Organization:** `org_avapardaz_sandbox` (`usr_studio_owner_01`, `prj_avapardaz_dev_01`)
- **Role Model:** 7 roles enforced (`OWNER`, `ADMIN`, `DEVELOPER`, `BILLING_ADMIN`, `ANALYST`, `VIEWER`, `SECURITY_AUDITOR`)
- **Invitations:** 72-hour expiration, HMAC-hashed token, strictly single-use
- **Tenant Isolation:** Server-derived tenant/project ownership verified; cross-tenant job retrieval rejected with `403 TENANT_ISOLATION_DENIED` + audit log

## C. API & SDKs
- **REST & Streaming:** `/v1/models`, `/v1/audio/estimates`, `/v1/audio/transcriptions`, `/v1/audio/transcriptions/:id(/result)`, `/v1/audio/streaming-sessions`
- **Webhooks:** HMAC-SHA256 signed (`t=<epoch>,v1=<hex>`), 6-step exponential backoff `[10s..6h]`, Dead-Letter Queue + manual replay
- **SDKs:** `@asr-platform/sdk` (`1.0.0-alpha.1` TypeScript) & `asr-platform-python` (`1.0.0a1` Python)

## D. Developer Experience
- Self-service **Developer Platform Portal** integrated in Studio UI (`DeveloperPlatformPortalModal.tsx`) with one-time API key creation, 24h overlap rotation, instant revocation, interactive `/v1` Playground, Ledger & Invoice view, Webhooks DLQ/Replay, and Region Residency tester.
- Time-to-first-success target (`< 5 min`): **Engineering implemented; external usability cohort not yet sampled (`NOT_MEASURED_EXTERNALLY`)**.

## E. Usage and Quotas
- **Authoritative Metering Units:** Integer `audio_milliseconds` and `AcceptedSampleCount / 16000`
- **Idempotency & Deduplication:** 24h scoped `Idempotency-Key` returns cached response on identical retry and `409 IDEMPOTENCY_CONFLICT` on payload divergence; `usageEventId` guarantees zero duplicate ledger debits.
- **Atomic Reservations:** Pre-execution reservation deducts from available balance into `reservedCreditMinor` cleanly with over-budget protection.

## F. Billing & Commercial Governance
- **Monetary Representation:** Strict integer minor units (`USD cents`), zero binary float ledger state.
- **Ledger & Invoices:** Immutable append-only `billing_ledger` + SHA-256 snapshot-locked `invoices`.
- **Reconciliation:** Usage-to-ledger reconciliation verified (`discrepancyMinor === 0`).
- **Payment Integration:** Signature + 300s timestamp + replay-protected PSP webhook verifier implemented; **LIVE PSP MERCHANT ACCOUNT NOT PROVISIONED / COMMERCIAL SALES NOT ACTIVATED**.

## G. Security
- API secrets `asr_test_...` / `asr_live_...` generated via `crypto.randomBytes(24)`, shown strictly once, hashed via HMAC-SHA256 with server pepper.
- Zero leakage of research corpora or model training checkpoints through `/v1/*`.

## H. Performance (Measured Local `G0_CPU_ONLY`)
- In-process Control Plane + Local CPU ASR pipeline executes synchronously in single-digit milliseconds (`< 50ms` per request in unit/API smoke checks).
- GPU throughput, multi-node P95 under 500 concurrent clients, and 16 GiB VRAM capacity remain **UNMEASURED PENDING GPU CLUSTER**.

## I. Regional Operations
- **Active Region:** `ir-thr-01` (`OPERATIONAL_SINGLE_REGION`)
- **Staged Region:** `eu-central-01` (`STAGED_NOT_OPERATIONAL` — blocked by tenant residency policy unless explicitly allowed and tested)
- **Session Locality:** Streaming sessions pinned to active region; live cross-region session migration disabled.

## J. Commercial Economics
- Pricing catalog version `2026-11-v1` populated with placeholder non-live unit tiers (`developer`, `starter`, `growth`, `business`, `enterprise`) requiring formal financial, tax, and legal sign-off before public billing launch.

## K. Release Readiness
- **Technical Readiness (Control Plane, Auth, Ledger, SDKs, Portal, Local ASR):** Verified via unit tests + tsc + Vite build + headless Chromium verification.
- **Commercial Launch Authorization:** **BLOCKED** pending external PostgreSQL/Redis provisioning, GPU worker cluster, legal review (ToS/Privacy/DPA), and licensed PSP checkout setup.

## L. Final Decision
**`ENGINEERING_COMPLETE_PRIVATE_ALPHA_READY`** (Technical Private Alpha Ready in Single-Region Local Sandbox; Commercial Production Sales Intentionally Held Pending External DB/GPU/PSP/Legal Provisioning).
