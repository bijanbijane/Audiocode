# Frontend / Platform Backend / Local Runtime Separation

Status: **Phase 0 — boundary contract and migration plan only**  
Target branch: `refactor/separate-web-platform-local-runtime`  
Base branch: `main`

## 1. Purpose

Separate the web presentation layer from remotely hosted platform services without turning local audio processing into a cloud dependency. AvaPardaz has three deployable/runtime boundaries, not merely two folders:

1. **Web application** — React/Vite UI, browser interaction, presentation state, and browser-safe adapters.
2. **Platform API** — account and subscription operations, license issuance/revocation, model catalogue and distribution metadata, payment/webhook handling, administrative control plane, and server-side persistence.
3. **Local audio runtime** — ASR inference, audio DSP, timeline/edit execution, local model lifecycle, Audition integration, and the local Companion process.

The local runtime is a first-class product runtime. It must not be absorbed into the remotely hosted Platform API.

## 2. Observed repository baseline

The repository currently has overlapping server responsibilities:

- Root `server.ts` is an Express server and also starts/hosts Vite in development. Its imports reach deeply into ASR engines, processing orchestration, Companion, platform control-plane/data-plane gateways, security services, and local model lifecycle code.
- `backend/src/server.ts` separately defines a Fastify/PostgreSQL platform server bootstrap, including authentication/payment, license/model revocation, platform service registration, health and readiness endpoints.
- Root `package.json` owns the existing Vite/React/Express toolchain. No `backend/package.json` was present at the time of this assessment, although the Fastify bootstrap dynamically imports `fastify` and `pg`.
- `src/App.tsx` is the web entry component, but it also imports browser-local audio, timeline, ASR and Companion-facing modules. These imports are not evidence that those modules should be moved to a cloud server.
- The repository also contains shared code under `packages/`; ownership must be determined per module rather than inferred from its directory name.

This document records the observed structural baseline. It does not claim that runtime tests or production deployment have been executed.

## 3. Target repository boundaries

The intended destination is a gradual ownership layout. Existing source paths remain in place until each move has a verified compatibility proof.

```text
apps/
  web/                 React + Vite application (eventual extraction)
  platform-api/        Fastify HTTP process (eventual extraction)
  companion/           Local Companion host (only if extraction is safe)

packages/
  api-contracts/       Versioned request/response schemas and DTOs
  api-client/          Browser-safe typed Platform API client
  local-asr/            Local ASR interfaces and adapters
  audio-runtime/        DSP, timeline and local processing
  license-core/         Shared cryptographic primitives/contracts only
  shared/               Small runtime-neutral utilities

backend/
  migrations/          PostgreSQL migrations and server persistence assets

src/                   Existing application source during the migration
docs/architecture/     Decisions, ownership inventory and migration evidence
```

The destination is a target, not a command to move every existing file. Do not create empty package shells or relocate files solely to make the tree look clean.

## 4. Ownership rules

### Web application

May own:
- React components, routes, view state, accessibility and presentation.
- Browser storage and browser-only interaction adapters.
- Typed API client calls through the published API contracts.
- Browser-local ONNX inference only where the current product intentionally supports it.

Must not own:
- Payment secrets, private signing keys, database credentials, server authorization decisions, or trusted license issuance.
- Direct PostgreSQL access or server-only Node APIs in browser bundles.

### Platform API

Owns:
- Account/session and server-side authorization.
- Subscription state, payment webhooks, license issuance and revocation.
- Ed25519 private-key operations and trusted server-side signing.
- Model catalogue, artifact metadata, entitlements and administrative platform operations.
- PostgreSQL persistence, migrations, rate limiting and server health/readiness.

Must not own:
- User audio editing execution or default ASR inference.
- Audition plugin runtime or the local Companion process.
- A mandatory network dependency for an already-issued offline entitlement during its paid validity period.

### Local audio runtime

Owns:
- CPU/local ONNX ASR execution and model loading.
- Audio ingestion, DSP, timeline edits, EDL generation, preview and export.
- Local project persistence, undo/redo, crash recovery and resource management.
- Audition CEP/host bridge and Companion communication.
- Device-bound P-256 operations and local verification of signed entitlements, according to the existing security contract.

Must not:
- Upload audio for inference by default.
- Require periodic internet connectivity to keep a valid paid offline entitlement usable.
- Trust client-supplied subscription status without local cryptographic verification.

## 5. Non-negotiable compatibility constraints

1. Preserve local/offline ASR and CPU execution. No cloud-ASR migration is part of this work.
2. Preserve Adobe Audition CEP integration and the Companion protocol.
3. Preserve Ed25519 server signing and public-key verification contracts.
4. Preserve device-bound P-256 behavior and secure local key storage.
5. Preserve offline entitlement validity through the paid term; do not introduce periodic online revalidation.
6. Preserve audio editing semantics: timeline/timebase, EDL, preview, export, undo/redo, crash recovery and project compatibility.
7. Keep browser bundles free of server secrets and server-only database drivers.
8. Do not remove Express or its routes until Fastify parity is demonstrated by route-level tests and consumer migration evidence.
9. Do not change public API behavior without a versioned contract and compatibility tests.
10. Avoid unrelated UI, ASR model, DSP, or product redesign in this refactor.

## 6. Migration sequence and acceptance gates

### Phase 0 — boundary contract (this commit)
- Record current ownership boundaries and constraints.
- Keep runtime behavior and source paths unchanged.
- Acceptance: documentation-only diff; no production behavior change.

### Phase 1 — complete dependency and route inventory
- Enumerate Express routes, middleware, environment variables, secrets, storage, and all imported server-only modules.
- Enumerate Fastify routes, schemas, auth rules, database tables, migrations, and service dependencies.
- Trace every UI-to-Express and UI-to-Companion call site.
- Classify every module as web-only, platform-only, local-runtime-only, or shared-contract.
- Acceptance: inventory includes owner, consumers, runtime assumptions, security classification, and proposed destination for every moved module.

### Phase 2 — API contracts and client boundary
- Define versioned schemas for requests, responses, errors, auth and entitlement payloads.
- Add runtime validation at API boundaries.
- Introduce a typed browser API client behind existing call sites.
- Acceptance: contract tests cover success, validation failure, auth failure, and backwards compatibility.

### Phase 3 — make Platform API independently installable and runnable
- Add a dedicated backend package manifest and lockfile strategy only after dependency inventory.
- Declare Fastify/PostgreSQL and required plugins explicitly; do not rely on dynamic imports as a substitute for declared dependencies.
- Add environment validation, migrations, graceful shutdown, health/readiness and deployment documentation.
- Acceptance: clean install and isolated backend build/test/start succeed without Vite or browser dependencies.

### Phase 4 — migrate routes incrementally
- Move one route family at a time to Fastify.
- Keep Express as a compatibility adapter/proxy for routes not yet migrated.
- Prove behavioral parity with contract and integration tests before switching each consumer.
- Acceptance: no route is deleted until all consumers and tests use the replacement.

### Phase 5 — extract web build and local runtime boundaries
- Separate web build configuration from API process configuration.
- Ensure Vite scans only browser-safe imports.
- Extract Companion/local runtime only where its current execution model and packaging support it.
- Acceptance: web build runs without backend-only dependencies; local runtime remains functional offline.

### Phase 6 — remove obsolete server paths
- Remove duplicate Express implementations only after route parity, observability and rollback checks.
- Keep a documented rollback path for at least one release.
- Acceptance: independent deployment, end-to-end web/API/Companion/Audition tests, and verified offline entitlement behavior.

## 7. Required verification before each migration PR

Run the repository's supported equivalents of:
- TypeScript/lint checks.
- Unit tests for changed modules.
- API contract and route parity tests.
- Web production build.
- Backend isolated build/start and PostgreSQL integration tests (where applicable).
- Local ASR smoke tests without network access.
- Companion and Audition protocol tests.
- Offline license verification tests, including expiry and device-binding cases.

A test that cannot run in the current environment must be reported as **not run**, never as passed.

## 8. Current change scope

This phase intentionally changes no runtime code, package manifests, lockfiles, routes, cryptographic logic, model files, or user data. The next implementation step is the exhaustive dependency/route inventory. Actual code movement is blocked until that inventory and the relevant test baselines exist.
