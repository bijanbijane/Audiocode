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

- `avapardaz-api` runs the existing Express API/local runtime on port 3000 with `DISABLE_WEB_HOST=true`; it does not serve the SPA.
- `avapardaz-web` serves only the Vite build through Nginx on port 8080.
- Put both containers on the same Docker network and make the API container resolvable as `avapardaz-api`, or change the upstream in `deploy/web/nginx.conf`.
- Nginx forwards `/api` and `/v1` without rewriting the paths. Request buffering is disabled for these routes so streaming audio requests are not unnecessarily buffered at the web tier.
- The Nginx static tier emits COOP, COEP, and CORP headers required by the browser audio/WASM environment, including cache-controlled HTML and asset locations.
- Nginx permits up to the current 100 MiB public-audio ingress ceiling, while Express applies its own narrower route-level limits (for example, 64 MiB for Smart Audio Edit). Proxy timeouts are set to 240 seconds to cover the existing three-minute edit operation timeout.

The existing `backend/Dockerfile` is intentionally not overwritten. It remains the legacy combined image until the separated deployment has passed parity checks.

## Non-negotiable behavior preserved

This change does not move or rewrite:
- local CPU/ONNX ASR, browser-local inference, DSP, project/timeline, EDL, preview, export, undo/redo, or crash-recovery code;
- Adobe Audition CEP, JSX host adapter, Companion IPC, or loopback security;
- Ed25519 lease/signature logic, P-256 device binding, or offline entitlement semantics;
- the local-only cloud-ASR prohibition.

The web tier is static-only. It does not receive private keys, database credentials, model storage, or audio-processing server code.

## Explicitly not complete yet

This is a real web/API **process and container split** plus a separately packaged Platform API scaffold; it is not the completed route migration.

The current Express `server.ts` still combines local-audio APIs and several platform-facing routes. Fastify/PostgreSQL now has its own `backend/package.json`, `backend/tsconfig.json`, `backend/src/main.ts`, and `backend/Dockerfile.platform-api`, but it is not yet the canonical production API. The standalone npm lockfile has not yet been generated and committed, and no full Express↔Fastify route-parity proof exists.

Do not delete Express, merge the duplicate license paths, or move local runtime modules until the next migration stage has:
1. a complete route and environment-variable ownership matrix;
2. a generated and committed `backend/package-lock.json`, with the image switched to `npm ci`;
3. successful Platform API typecheck, backend tests, Docker build and PostgreSQL integration tests;
4. route-level response/authentication/signature parity tests;
5. explicit ownership for overlapping Ed25519/license/model routes;
6. passing web build, local-ASR tests, Companion/CEP tests, and security/offline-entitlement tests.

## Validation status for this slice

- GitHub source changes are committed on `refactor/separate-web-platform-local-runtime`.
- The existing PR quality workflows currently report failure on the earlier documentation-only commit. The GitHub connector did not return their job logs (the log-download endpoint returned a storage 404), so the failure cause is not yet established.
- A separate Fastify package, executable entrypoint and Dockerfile are committed, but the standalone lockfile generation/build workflow is currently blocked before runner allocation.
- No local Docker build, Vite build, TypeScript check, Fastify startup or runtime test has been executed through the GitHub connector. The new CI run must be inspected before this slice is called validated.
