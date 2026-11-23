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

### 2.3 Security and license routes — Hosted compatibility facade is active

| Route | Express implementation | Fastify implementation | Status |
|---|---|---|---|
| `POST /api/v1/license/lease` | `PlatformLicenseService.issueOfflineLicenseLease` | `PlatformBackendServices.registerAllRoutes` | **Hosted compatibility active.** The legacy Express route forwards to Fastify; Fastify emits the legacy `payloadBase64` / `signatureBase64` / `algorithm` / `keyVersion` envelope understood by `OfflineCryptoVerifier`, plus DB-backed fields. Lease ID is a PostgreSQL UUID; offline expiry is set to paid `current_period_end`. A source test calls the browser verifier four days later against a seven-day paid subscription whose configured `offline_grace_hours` is 72. Test has not run in CI yet. |
| `GET /api/v1/crypto/public-key` | Express `PlatformLicenseService.getPublicKeyInfo` | `PlatformBackendServices.getPublicKeyInfo` | **Hosted compatibility active.** Express forwards this legacy path to Fastify; Fastify returns the SPKI Base64 Ed25519 key and key metadata. The existing production key pair and keyVersion must remain unchanged until all clients complete a versioned key migration. |
| `GET /api/v1/models/:modelId/manifest` | Express `PlatformLicenseService.issueSignedModelManifestEnvelope` | New Fastify alias reads PostgreSQL catalog/chunks and signs the legacy manifest envelope | **Hosted compatibility active.** Express forwards the legacy route to Fastify. Only legacy-supported statuses and GROUP_A/GROUP_B tiers are exposed; `OfflineCryptoVerifier.verifyModelManifest()` is included in source tests. |
| Device-seat and sync routes | No matching direct Express paths identified in this scan | `POST /api/v1/license/enforce-device-seat`, `POST /api/v1/license/sync-state` | Fastify-only routes; require UI/client consumer discovery |
| Model revocation | Express model-factory/admin surfaces exist, but no exact match confirmed | `POST /api/v1/admin/models/:modelId/:version/revoke` | Do not treat similarly named admin operations as equivalent |

**Security invariant:** retain the currently deployed Ed25519 key pair and keyVersion during this compatibility phase; a key change requires a versioned client key-discovery/cache migration. Retain P-256 device-bound key handling and secure local storage; keep valid paid offline entitlement valid until the paid subscription end. Do not introduce periodic network checks as a condition for local processing.

**Legacy Express Hosted compatibility adapter:** the old `GET /api/v1/crypto/public-key`, `POST /api/v1/license/lease`, and `GET /api/v1/models/:modelId/manifest` paths forward to the internal Fastify Platform API when `AudioApiSecurityGuard` is in Hosted mode. Local mode retains the legacy demo signer. The lease adapter hashes a legacy raw device fingerprint on the server; Fastify re-computes SHA-256 and constant-time compares it with the supplied digest before issuing a lease. The adapter strips client-supplied plan, grace period, and unknown fields. An optional legacy `userId` is forwarded only for a consistency check and Fastify rejects it unless it equals the authenticated JWT subject. The new browser client `src/platform/PlatformApiClient.ts` sends a Bearer token and a SHA-256 device fingerprint hash, never a client-supplied plan or user ID. It is not yet connected to a real user-facing login/account screen.

**Compatibility work now present:** in Hosted mode the legacy Express public-key, lease and model-manifest URLs forward to Fastify; Local mode retains the local compatibility signer. The adapter hashes a legacy raw device fingerprint, strips plan/grace overrides, and Fastify independently re-hashes and constant-time verifies any raw/hash pair before issuing a lease. The existing Ed25519 key pair and `keyVersion` remain unchanged until a versioned client key-discovery/cache rollout. The PostgreSQL lease UUID and paid-period expiry are covered by source tests using the current browser verifier. The Fastify manifest alias signs the legacy manifest shape. Chunk delivery requires a registered PostgreSQL chunk row, enforces model-root realpath confinement, a 16 MiB size ceiling, exact byte length and SHA-256 before returning full or ranged bytes; revoked models return 410. These tests are committed source, not proof of an executed CI run. The user-facing login/account UI is not wired to `PlatformApiClient`; full production PostgreSQL integration and successful build/test execution remain unverified.

### 2.4 Fastify/PostgreSQL route inventory

Observed Fastify registrations in:
- `backend/src/BackendAuthAndPaymentService.ts`
- `backend/src/BackendLicenseAndModelRevocationService.ts`
- `backend/src/PlatformBackendServices.ts`
- `backend/src/BackendApplicationFactory.ts`
- `backend/src/server.ts`

**Important bootstrap distinction:** the production entrypoint added in this branch (`backend/src/main.ts`) calls `bootstrapBackendServer()` from `backend/src/server.ts`. That bootstrap registers auth/payment, license/model and revocation services, plus `/healthz` and `/readyz`. It does **not** call `buildBackendApplication()` from `BackendApplicationFactory.ts`. Therefore the Factory-only modules/routes (including the enterprise-key endpoint, canary rollout service, external API proxy routes, metrics hooks and advisory-lock coordinator) are not currently part of the runnable production Fastify server, even though they exist in source. Treat them as implemented modules, not live endpoints, until the production bootstrap is unified and covered by startup/integration tests.

| Routes | Service | Classification |
|---|---|---|
| `POST /api/v1/auth/register`, `POST /api/v1/auth/login` | `BackendAuthAndPaymentService` | Platform identity/auth |
| `POST /api/v1/payments/webhook` | `BackendAuthAndPaymentService` | Platform payment webhook |
| `POST /api/v1/license/lease` | `PlatformBackendServices` | Platform offline lease |
| `POST /api/v1/license/enforce-device-seat`, `POST /api/v1/license/sync-state` | `BackendLicenseAndModelRevocationService` | Platform license device enforcement/state sync |
| `POST /api/v1/admin/models/:modelId/:version/revoke` | `BackendLicenseAndModelRevocationService` | Platform admin revocation |
| `GET /api/v1/models/catalog`, `GET /api/v1/models/:modelId/:version/manifest`, `GET /api/v1/models/:modelId/:version/chunks/:chunkIndex` | `PlatformBackendServices` | Platform catalog and signed model delivery; chunk delivery rechecks revocation (410), requires the exact PostgreSQL chunk row, enforces path/realpath confinement and exact metadata length, and verifies SHA-256 before returning immutable or ranged bytes |
| `POST /api/v1/telemetry/model-delivery` | `PlatformBackendServices` | Privacy-minimized delivery telemetry |
| `POST /api/v1/asr/transcribe-chunk` | `PlatformBackendServices` | Server-side ASR extension point; disabled by default in v1 |
| `POST /api/v1/admin/enterprise-keys` | `BackendApplicationFactory` | Platform admin API keys |
| `GET /healthz`, `GET /readyz` | Fastify bootstrap/factory | Liveness and database readiness |

## 3. Dependency and deployment blockers found

1. Root `package.json` has no direct `fastify` or `pg` dependency.
2. Root `bun.lock` is the repository CI lockfile; the audited lock does not contain Fastify or PostgreSQL's `pg` client.
3. The repository previously had no standalone Platform API package. This branch now adds `backend/package.json`, a scoped `backend/tsconfig.json`, and `backend/src/main.ts`. The standalone typecheck/test graph is deliberately limited to the production Fastify bootstrap and directly owned auth/license/PostgreSQL modules. Browser-verifier and Nginx/Compose contract tests run from the root monorepo suite, not from the standalone package.
4. A standalone image definition now exists at `backend/Dockerfile.platform-api`. The original `backend/Dockerfile` remains the legacy combined Express+Vite image, and `backend/Dockerfile.api` is the separate Express/local-runtime process image. The latter still uses the root Bun lock and source graph; its dependency graph has not yet been split from the Web monorepo.
5. No committed `backend/package-lock.json` or `backend/bun.lock` exists yet. The new standalone Platform API workflow generates an npm lockfile in the runner and uploads it as an artifact. `backend/Dockerfile.platform-api` now requires that file and uses `npm ci`; until the artifact is committed, a direct Platform API image build from a fresh checkout correctly fails closed rather than silently resolving an unlocked dependency graph.
6. The Fastify bootstrap requires `DATABASE_URL`, Ed25519 private/public PEM keys, and `PAYMENT_WEBHOOK_HMAC_SECRET`; these must be provisioned only in the Platform API environment, never in the Vite bundle. `ADMIN_API_SECRET_KEY` should also be provisioned for protected admin operations.
7. `src/App.tsx` imports browser-local ASR/runtime, Companion client, workflow and DSP modules. Moving all of `src/` under a server package would break the product.
8. Multiple routers are mounted through Express; a direct-route grep is not a complete API inventory. This includes Platform Control Plane, Model Factory, Speech Security, Smart Audio Edit, Shahab, local model artifacts and Companion routers.

## 4. Migration sequence and acceptance gates

### Gate A — Web/API process split (implemented in this PR)

- Web dev server and API dev server have independent commands.
- Separate static Nginx image and API/local-runtime image exist.
- Legacy combined `npm run dev` and legacy `backend/Dockerfile` remain as rollback paths.
- API proxy preserves `/api` and `/v1` paths and disables request buffering for streaming bodies.
- Nginx body ceiling matches the current 100 MiB server-side upload ceiling; route-level lower limits remain enforced by Express. Proxy timeouts allow 240-second edit operations.
- COOP/COEP/CORP isolation headers are explicitly repeated in cache-controlled locations so index and asset responses retain the browser audio/WASM isolation policy.
- Status: **implemented, not yet CI-validated**.

### Gate B — Canonical route contract

- Generate a machine-readable route table for every direct route and mounted router.
- Record request/response schemas, status codes, auth policy, tenant scope, data source, idempotency, streaming/range behavior and owning runtime.
- Add consumer inventory from browser code, tests, Audition CEP, Companion and admin surfaces.
- Compatibility implementations now cover the legacy license envelope/paid expiry, public-key discovery, and model-manifest payload. Keep the Hosted Express facade forwarding to Fastify while full auth, model delivery, and deployment parity are validated.
- Unify or explicitly scope `bootstrapBackendServer` vs `buildBackendApplication`; add a real Fastify startup test that asserts the production route inventory, including any Factory-only modules intended to be live.
- The three Hosted legacy Express URL facades already forward to Fastify; keep the remaining local/control-plane route families on Express until their consumers, auth, persistence and local-vs-cloud data policies are proven.

### Gate C — Independently runnable Platform API

- **Scaffold added in this PR:** `backend/package.json`, `backend/tsconfig.json`, `backend/src/main.ts`, `backend/Dockerfile.platform-api`, and a dedicated CI workflow.
- The manifest declares Fastify `5.12.8`, PostgreSQL client `pg` `8.23.1`, and `tsx`; the npm registry pages showed those as the current stable releases when this change was authored. [Fastify](https://www.npmjs.com/package/fastify) · [pg](https://www.npmjs.com/package/pg)
- **Still open:** commit a generated standalone `backend/package-lock.json`; change the Platform API image to `npm ci`; execute typecheck, all backend tests, Docker build, and PostgreSQL integration tests.
- Build and run the Platform API without importing root Express/Vite entrypoints.
- Keep its environment secrets isolated; fail closed when required values are missing.
- Treat the Express Local Audio Runtime package/lockfile split as a separate follow-on gate; do not claim its dependency graph is independent merely because it has its own container.
- Run PostgreSQL migrations and integration tests in a disposable test database.
- Keep the three legacy Hosted facades forwarding to Fastify; do not move additional license/admin/model consumers until signature, auth, storage and response parity tests pass.

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
- The new Fastify executable entrypoint, package manifest, TypeScript config, standalone Dockerfile and workflow are committed, but none has been executed because GitHub has not assigned a runner.
- Source-level tests now cover the Fastify legacy license envelope and public-key discovery against `OfflineCryptoVerifier`, paid subscription expiry, UUID lease IDs, legacy model-manifest response, REVOKED and unregistered chunk denial, SHA-256/length validation, strict model path validation, root proxy/Compose routing, Local-mode loopback binding, and the no-Vite API-only path. The standalone Fastify test/typecheck set is scoped to runtime-owned files. These are added tests, not executed results.
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
