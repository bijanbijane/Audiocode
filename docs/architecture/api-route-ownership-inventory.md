# API Route Ownership and Runtime Migration Inventory

> Status: source-inspected inventory on the refactor branch. This document is evidence for migration planning, not a claim that routes have already moved or that two servers are equivalent.

## 1. Runtime map

| Runtime | Current entrypoint | What it actually owns today | Migration destination |
|---|---|---|---|
| Web application | `src/main.tsx`, `src/App.tsx`, Vite | React presentation plus browser-local ONNX, browser audio, project/timeline/EDL state, OPFS, and browser-side Companion/API clients | Independent static Web tier |
| Existing API + local runtime | Root `server.ts` (Express) | 90+ direct route registrations and mounted routers; local session, Companion, Shahab, local-model artifact delivery, smart-edit orchestration, DSP/ASR-related endpoints, and several platform/control-plane domains | Split by domain: local-runtime API vs Platform API |
| Platform API implementation | `backend/src/server.ts` (Fastify) | PostgreSQL-backed auth/payment, license/device-seat, revocation, catalog/manifest/chunk delivery and telemetry services | Independent Platform API |
| Audio/host integration | `src/asr-core/`, `src/processing-engine/`, `src/workflow/`, `src/host-bridge/`, `packages/audio-runtime/`, `packages/audition-cep-plugin/` | Local processing and editor/host contracts used by browser, Companion and Audition | Local Audio Runtime and browser-local packages; never blindly move to Platform API |

## 2. Express routes: ownership decisions

The root Express server has the following direct path registrations, plus mounted routers. Routes are grouped here by current behavior and intended owner. Any route marked **contract review** must remain on its current server until its request/response, auth, persistence, and offline behavior are tested.

### 2.1 Local Audio Runtime — keep out of the Platform API

| Current route family | Current owner | Reason |
|---|---|---|
| `POST /api/local-auth/session` | Express / `AudioApiSecurityGuard` | Local loopback session bootstrap and local-mode policy |
| `/api/v2/companion/**` | Express / `LocalCompanionService` | Native Companion IPC; loopback-only and local-mode gated |
| `/api/v2/smart-edit/**` | Express / `SmartAudioEditHttpRouter` | Smart-edit jobs, decisions, preview, render, export and cancel orchestration |
| `/api/shahab/**` | Express / `ShahabHttpRouter` plus local Shahab operations handlers | Local Shahab runtime, memory/consent/diagnostics and local execution state |
| `/api/v1/local-models/shenava-rizen/**` | Express / `LocalModelArtifactHttpRouter` | Local model artifact access with integrity, path-confinement and byte-range controls |
| `/api/v1/asr/health`, `/api/v1/asr/models`, `/api/v1/asr/transcriptions`, `/api/v1/asr/checkpoints/**` | Express | Existing engine/model orchestration; verify local inference and storage semantics before any move |
| `/api/v1/asr-core/**` | Express / Core ASR modules | Local ASR core, benchmarks and router diagnostics |
| `/api/v1/processing/**` | Express / `UnifiedProcessingOrchestrator` | Local-first processing execution and capability reporting |
| `/api/v1/streaming/backends`, `/api/v1/router/**` | Express | Runtime backend selection and local routing evaluations |
| `/api/v1/lab/provider-transcribe`, `/api/v1/engines`, `/api/v1/benchmark/leaderboards` | Express | Development/research engine endpoints; classify separately from customer Platform API |

**Hard rule:** local inference, local media paths, audio buffers, local Companion IPC and local project data must not be proxied to a cloud Platform API as part of this extraction.

### 2.2 Platform/control-plane candidates still hosted by Express

These route families appear platform-facing by domain, but their actual persistence and auth implementations are wired through in-process gateways in root `server.ts`. They are candidates for a later Platform API extraction only after a contract/consumer review.

| Current route family | Current implementation | Required migration evidence |
|---|---|---|
| `/api/v1/platform/**` | `PlatformControlPlaneHttpRouter` + `PlatformControlPlaneGateway` | Auth scopes, tenant isolation, idempotency, persistence and webhook replay parity |
| `/v1/models`, `/v1/models/:id` | Express `PlatformDataPlaneGateway` | Prove exact relationship to PostgreSQL catalog and model version identity |
| `/v1/capabilities/**` | Express platform gateway | Stable public capability schema and versioning |
| `/v1/intelligence/jobs/**` | Express platform gateway | Durable job ownership, cancellation, artifact access and tenant controls |
| `/v1/recordings/**`, `/v1/integrations/**` | Express platform gateway | Data retention, authorization and confirmation that user audio/transcripts are not uploaded |
| `/v1/data/**`, `/v1/datasets/**` | Express data-factory routes | Tenant/rights checks, data lifecycle, audit, retention and storage ownership |
| `/api/v1/data-factory/sandbox/**` | Express + `requireSandboxStudioAccess` | Keep sandbox disabled unless the explicit high-entropy token and tenant/operator scope are configured |
| `/api/v1/model-factory/sandbox/**`, `/v1/ml/**` | Express `ModelFactoryHttpRouter` | Admin authorization, model provenance, training/deployment lifecycle and audit parity |
| `/api/v1/security/sandbox/**`, `/v1/security/**` | Express `SpeechSecurityHttpRouter` | Separate public security API from internal sandbox/admin operations |
| `POST /v1/audio/transcriptions`, `/v1/audio/estimates`, `/v1/audio/streaming-sessions`, `/v1/audio/transcriptions/:id/**` | Express `PlatformDataPlaneGateway` | Verify no cloud audio upload under the local-only ASR policy; classify metadata-only vs audio-bearing requests |

### 2.3 Security and license routes — overlap; do not switch yet

| Route | Express implementation | Fastify implementation | Status |
|---|---|---|---|
| `POST /api/v1/license/lease` | `PlatformLicenseService.issueOfflineLicenseLease` | `PlatformBackendServices.registerAllRoutes` | **Direct overlap.** Payload, expiry, plan mapping, device binding, signature canonicalization and client verifier parity are not proven |
| `GET /api/v1/crypto/public-key` | `PlatformLicenseService.getPublicKeyInfo` | Fastify exposes Ed25519 key material inside its service configuration/envelopes; no matching public-key route was found in the audited route list | Contract mismatch until a dedicated parity test exists |
| `GET /api/v1/models/:modelId/manifest` | Express `PlatformLicenseService.issueSignedModelManifestEnvelope` | Fastify uses `GET /api/v1/models/:modelId/:version/manifest` | Different route shape and data source; not equivalent |
| Device-seat and sync routes | No matching direct Express paths identified in this scan | `POST /api/v1/license/enforce-device-seat`, `POST /api/v1/license/sync-state` | Fastify-only routes; require UI/client consumer discovery |
| Model revocation | Express model-factory/admin surfaces exist, but no exact match confirmed | `POST /api/v1/admin/models/:modelId/:version/revoke` | Do not treat similarly named admin operations as equivalent |

**Security invariant:** retain Ed25519 signing and verification semantics; retain P-256 device-bound key handling and secure local storage; keep valid paid offline entitlement valid until the paid subscription end. Do not introduce periodic network checks as a condition for local processing.

### 2.4 Fastify/PostgreSQL route inventory

Observed Fastify registrations in:
- `backend/src/BackendAuthAndPaymentService.ts`
- `backend/src/BackendLicenseAndModelRevocationService.ts`
- `backend/src/PlatformBackendServices.ts`
- `backend/src/BackendApplicationFactory.ts`
- `backend/src/server.ts`

| Routes | Service | Classification |
|---|---|---|
| `POST /api/v1/auth/register`, `POST /api/v1/auth/login` | `BackendAuthAndPaymentService` | Platform identity/auth |
| `POST /api/v1/payments/webhook` | `BackendAuthAndPaymentService` | Platform payment webhook |
| `POST /api/v1/license/lease` | `PlatformBackendServices` | Platform offline lease |
| `POST /api/v1/license/enforce-device-seat`, `POST /api/v1/license/sync-state` | `BackendLicenseAndModelRevocationService` | Platform license device enforcement/state sync |
| `POST /api/v1/admin/models/:modelId/:version/revoke` | `BackendLicenseAndModelRevocationService` | Platform admin revocation |
| `GET /api/v1/models/catalog`, `GET /api/v1/models/:modelId/:version/manifest`, `GET /api/v1/models/:modelId/:version/chunks/:chunkIndex` | `PlatformBackendServices` | Platform catalog and signed model delivery |
| `POST /api/v1/telemetry/model-delivery` | `PlatformBackendServices` | Privacy-minimized delivery telemetry |
| `POST /api/v1/asr/transcribe-chunk` | `PlatformBackendServices` | Server-side ASR extension point; disabled by default in v1 |
| `POST /api/v1/admin/enterprise-keys` | `BackendApplicationFactory` | Platform admin API keys |
| `GET /healthz`, `GET /readyz` | Fastify bootstrap/factory | Liveness and database readiness |

## 3. Dependency and deployment blockers found

1. Root `package.json` has no direct `fastify` or `pg` dependency.
2. Root `bun.lock` is the repository CI lockfile; the audited lock does not contain Fastify or PostgreSQL's `pg` client.
3. `backend/package.json` and a standalone backend lockfile were absent when inspected.
4. Root `backend/Dockerfile` is explicitly documented as the combined Express+Vite runtime; it bundles root `server.ts`, not `backend/src/server.ts`.
5. Fastify bootstrap requires `DATABASE_URL`, Ed25519 private/public PEM keys, and `PAYMENT_WEBHOOK_HMAC_SECRET`; these must be provisioned only in the Platform API environment, never in the Vite bundle.
6. `src/App.tsx` imports browser-local ASR/runtime, Companion client, workflow and DSP modules. Moving all of `src/` under a server package would break the product.
7. Multiple routers are mounted through Express; a direct-route grep is not a complete API inventory. This includes Platform Control Plane, Model Factory, Speech Security, Smart Audio Edit, Shahab, local model artifacts and Companion routers.

## 4. Migration sequence and acceptance gates

### Gate A — Web/API process split (implemented in this PR)

- Web dev server and API dev server have independent commands.
- Separate static Nginx image and API/local-runtime image exist.
- Legacy combined `npm run dev` and legacy `backend/Dockerfile` remain as rollback paths.
- API proxy preserves `/api` and `/v1` paths and disables request buffering for streaming bodies.
- Status: **implemented, not yet CI-validated**.

### Gate B — Canonical route contract

- Generate a machine-readable route table for every direct route and mounted router.
- Record request/response schemas, status codes, auth policy, tenant scope, data source, idempotency, streaming/range behavior and owning runtime.
- Add consumer inventory from browser code, tests, Audition CEP, Companion and admin surfaces.
- Resolve the three license/model route mismatches above before proxy changes.

### Gate C — Independently runnable Platform API

- Add `backend/package.json`, its own pinned lockfile and TypeScript/build/test configuration.
- Declare Fastify, `pg`, and only the runtime/build dependencies actually imported.
- Build and test the Platform API without importing root Express/Vite entrypoints.
- Keep its environment secrets isolated; fail closed when required values are missing.
- Run PostgreSQL migrations and integration tests in a disposable test database.
- Do not proxy overlapping license/model endpoints until signature and response parity tests pass.

### Gate D — Move platform domains incrementally

- Auth/payment first, then model catalog/delivery, then explicit license routes, then admin/control-plane surfaces.
- Use versioned contracts and compatibility tests; keep old Express route as a compatibility adapter only while parity is proven.
- Keep local ASR, audio streaming, DSP, project/timeline, Companion, Shahab local execution and CEP workflows owned by the Local Audio Runtime.

### Gate E — Local Audio Runtime packaging

- Give local-runtime its own package boundary and deployment/runtime manifest.
- Preserve loopback-only access, origin/host/replay protections, native Companion lifecycle and local model storage.
- Do not convert local processing APIs into cloud services.

### Gate F — Remove legacy coupling only after evidence

- Remove the Express web-host code only after independent web/API deployments pass.
- Remove duplicated Express platform routes only after route-level parity and client migration.
- Retire the combined `backend/Dockerfile` only after a full staged rollout and rollback drill.
- Never delete the local runtime or fallback code simply to reduce file count.

## 5. Validation currently available

- Source paths and literal route registrations were inspected through GitHub.
- The main-branch baseline quality workflows at `90fafa8d03a1699614269564a759a63c6bd247f3` also failed before runner allocation (`runner_id=0`, zero executed steps).
- The separated-container workflow likewise failed before runner allocation and produced no artifacts; retry attempt 2 also received no runner.
- GitHub's job-log download currently returns an object-storage 404, so there is no command-level diagnostic log from these jobs.
- No claim is made that Docker build, typecheck, Vite build, Fastify startup, PostgreSQL integration, local ASR, Companion/CEP or offline-license tests passed in this editing session.

## 6. Stop conditions (safety, not excuses)

Do not advance an API route if it would:
- send raw audio or transcripts to a hosted service against the local-only policy;
- change offline license validity or require periodic connectivity during a paid subscription;
- alter Ed25519/P-256 trust boundaries;
- expose database credentials/private keys in browser code;
- break Audition CEP or Companion IPC;
- change timeline/EDL, preview, export, undo/redo or crash recovery semantics.

A blocked CI runner is an infrastructure blocker, not permission to mark a change green or bypass all tests. Continue with source inspection and isolated code preparation, but keep the PR in Draft until real execution evidence exists.
