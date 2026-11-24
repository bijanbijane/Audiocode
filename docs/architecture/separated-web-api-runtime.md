# Separated Web and API Runtime — Implementation Slice 1

## Objective

Run the React/Vite browser application independently from the current Express API/local-audio runtime, without changing audio processing, model execution, licensing, or Adobe Audition behavior.

This slice creates a deployable boundary between the **web presentation tier** and the **existing API/runtime tier**. It does not claim that the Fastify/PostgreSQL platform backend has replaced Express.

## Current topology established by repository inspection

| Responsibility | Current owner | Notes |
|---|---|---|
| Browser UI | `index.html`, `src/main.tsx`, `src/App.tsx`, Vite | React/Vite static build |
| HTTP API and local runtime | Root `server.ts` (Express) | Hosts the existing `/api/*` and `/v1/*` routes, local ASR/DSP orchestration, Shahab routes, and Companion integration |
| Browser-local runtime | `src/asr-core/`, `src/processing-engine/`, `src/workflow/`, `src/lifecycle/` | Includes browser ONNX/OPFS paths; these are not server-only modules |
| Host integration | `src/host-bridge/`, `packages/audition-cep-plugin/` | CEP/Companion behavior must remain intact |
| Platform backend implementation | `backend/src/main.ts` → `backend/src/server.ts` | Now has a standalone executable entrypoint, package manifest, TypeScript config and `backend/Dockerfile.platform-api`; it is not yet the canonical owner of existing Express routes |
| Existing combined container | `backend/Dockerfile` | Explicitly builds root `server.ts` (Express + Vite); retained for backward compatibility during migration |

The root Express server currently has 90+ literal route registrations, plus mounted routers. The API surface includes local session/Companion/ASR and processing routes, platform model/catalog routes, data/model/security factory routes, and Shahab operations. The browser UI must not be treated as a thin frontend: it also owns browser-local audio, timeline, project, model, and host-client workflows.

## New separated development workflow

Use two terminals:

**Terminal 1 — API and local runtime**
```bash
npm run dev:api
```

This starts the current Express API/local-runtime server with `DISABLE_EMBEDDED_VITE=true`. It does not mount Vite middleware or serve the browser app.

**Terminal 2 — browser application**
```bash
npm run dev:web
```

Open `http://localhost:5173`. Vite runs as a separate process and proxies `/api` and `/v1` to `http://127.0.0.1:3000`. Set `API_PROXY_TARGET` when the API listens elsewhere.

For a production-like static preview, use `npm run preview:web`; it listens on port 4173 and uses the same proxy target.

The original `npm run dev` remains unchanged for compatibility. API proxying is enabled only for Vite mode `separate`; it is deliberately disabled in the old embedded-Vite path to avoid a proxy loop back into the same Express process.

## Independent container builds

Build from the repository root:

```bash
docker build -f backend/Dockerfile.api -t avapardaz-api .
docker build -f deploy/web/Dockerfile -t avapardaz-web .
```

- `avapardaz-api` runs the existing Express API/local runtime on port 3000 with `DISABLE_WEB_HOST=true`; it does not serve the SPA. Its image still builds from the root `package.json`/`bun.lock` because the Local Audio Runtime imports the current root `src/` module graph. This is process/container separation, not yet a separately locked local-runtime package.
- `avapardaz-web` serves only the Vite build through Nginx on port 8080.
- For the local-only Compose topology, these remain separate containers but share a network namespace. Nginx reaches Express at `127.0.0.1:3000`, so `AudioApiSecurityGuard` continues to see a real loopback peer and does not need a weakened proxy exception.
- `avapardaz-platform-api` is a third, separately networked Fastify/PostgreSQL service. The browser addresses it through `/platform-api/`; Nginx strips this prefix before forwarding. The legacy `/api/` and `/v1/` paths still reach Express.
- The Nginx/Web port alone is bound to `127.0.0.1` on the host. The containerized Express port is deliberately not published: Companion validates the true socket peer as loopback, while Docker host-port NAT may present a bridge IP. For host Audition/Companion, run `npm run dev:api` natively on `127.0.0.1:3000`; do not weaken the Companion guard. This configuration is local-only, not an internet-facing hosted deployment.
- Nginx forwards `/api` and `/v1` without rewriting the paths. Request buffering is disabled for these routes so streaming audio requests are not unnecessarily buffered at the web tier.
- The Nginx static tier emits COOP, COEP, and CORP headers required by the browser audio/WASM environment, including cache-controlled HTML and asset locations.
- The Fastify model chunk volume is separate and read-only to the Platform API; it is not shared with the Local Audio Runtime's model storage.
- The Fastify chunk endpoint re-checks the live release state, requires a PostgreSQL chunk registration, confines the resolved path under the model root, caps chunk sizes at 16 MiB, checks exact file length, and verifies SHA-256 before returning either a full chunk or a range.
- The Express container healthcheck uses `/healthz` for process liveness only. `/api/v1/asr/health` reports the actual Sherpa executable/model provisioning state and returns `DEGRADED` when either is missing. The automatic installer in the current `LocalSherpaNeuralEngine` is explicitly Linux-x64-only; an ARM64 container on Apple Silicon is not assumed to have working local ASR. Container health is not proof of inference readiness.
- Nginx permits up to the current 100 MiB public-audio ingress ceiling, while Express applies its own narrower route-level limits (for example, 64 MiB for Smart Audio Edit). Proxy timeouts are set to 240 seconds to cover the existing three-minute edit operation timeout.

The existing `backend/Dockerfile` is intentionally not overwritten. It remains the legacy combined image until the separated deployment has passed parity checks.

## Non-negotiable behavior preserved

This change does not move or rewrite:
- local CPU/ONNX ASR, browser-local inference, DSP, project/timeline, EDL, preview, export, undo/redo, or crash-recovery code;
- Adobe Audition CEP, JSX host adapter, Companion IPC, or loopback security;
- P-256 device binding, secure local storage, or the offline verifier. The Fastify compatibility signer uses the existing production Ed25519 key pair and keyVersion during this migration; no key rotation is authorized here;
- the local-only cloud-ASR prohibition.

The web tier is static-only. It does not receive private keys, database credentials, model storage, or audio-processing server code.

## Explicitly not complete yet

This is a real web/API **process and container split** plus a separately packaged Platform API scaffold, with a dedicated `/platform-api/` ingress route; it is not the completed route migration.

The current Express `server.ts` still combines local-audio APIs and several platform-facing routes. Fastify/PostgreSQL now has its own package, executable entrypoint, image definition, and dedicated `/platform-api/` ingress. Hosted Express compatibility facades now forward legacy public-key, offline-lease and model-manifest requests to Fastify; Local mode retains the old local signer. Source tests invoke the existing `OfflineCryptoVerifier` for lease and manifest. The adapter strips plan/grace overrides, and Fastify checks JWT identity plus the raw-device-fingerprint/hash relationship. Fastify retains the existing production Ed25519 key pair and keyVersion during this phase. Model chunk delivery has registration, revocation, root-confinement, byte-length and SHA-256 checks in source, but full PostgreSQL integration remains unverified. Real login/account UI wiring and CI execution are still incomplete. The standalone npm lockfile has not yet been generated and committed. The Platform API Dockerfile requires it and uses `npm ci`, so its image remains intentionally unbuildable from a fresh checkout until the lockfile is committed.

Do not delete Express, merge the duplicate license paths, or move local runtime modules until the next migration stage has:
1. a complete route and environment-variable ownership matrix;
2. a generated and committed `backend/package-lock.json`, with the image switched to `npm ci`;
3. successful Platform API typecheck, backend tests, Docker build and PostgreSQL integration tests;
4. route-level response/authentication/signature parity tests;
5. explicit ownership for overlapping Ed25519/license/model routes, preserving the existing Ed25519 key identity until a versioned client rotation is completed;
7. passing web build, local-ASR tests, Companion/CEP tests, and security/offline-entitlement tests.

## Validation status for this slice

- GitHub source changes are committed on `refactor/separate-web-platform-local-runtime`.
- The existing PR quality workflows currently report failure on the earlier documentation-only commit. The GitHub connector did not return their job logs (the log-download endpoint returned a storage 404), so the failure cause is not yet established.
- A separate Fastify package, executable entrypoint and Dockerfile are committed. Its typecheck/test set is now limited to the live Fastify bootstrap and directly owned services; the root integration suite separately covers Web/Express/Fastify contracts.
- The standalone lockfile generation/build workflow and the web/API container workflow repeatedly fail before runner allocation (`runner_id=0`, zero steps, no artifacts). The same behavior is present on the base `main` commit.
- No local Docker build, Vite build, TypeScript check, Fastify startup or runtime test has been executed through the GitHub connector. These checks remain unverified.
