# Runtime Dependency Boundary Inventory

**Status:** source-derived inventory on `refactor/separate-web-platform-local-runtime`. This is not a claim that the three dependency graphs are already independently locked.

## 1. Runtime entrypoints and ownership

| Runtime | Current entrypoint | Runtime responsibility | Package/lock state |
|---|---|---|---|
| Web UI | `src/main.tsx` → `src/App.tsx` | React presentation, browser audio transport, browser-local ONNX, local project/timeline/EDL, DSP controls, Companion browser client | Still built from root `package.json` and `bun.lock` |
| Local Audio Runtime | root `server.ts`; API-only launcher `scripts/start-api.ts` | Express local HTTP API, local ASR orchestration, local model artifact access, Companion IPC, Smart Audio Edit, Shahab runtime, local security, project/audio operations | Separate process and image exist, but still installs root `package.json` and `bun.lock` |
| Platform API | `backend/src/main.ts` → `backend/src/server.ts` | Fastify auth/payment, PostgreSQL-backed subscriptions and device seats, offline lease issuance, model catalog/manifest/chunk delivery, revocation, platform telemetry | Separate `backend/package.json` and scoped `backend/tsconfig.json`; standalone `backend/package-lock.json` is not yet generated/committed |

## 2. Web dependency boundary

`src/main.tsx` is the browser entrypoint. It creates the React root and loads `src/App.tsx`. The App imports browser-facing components and modules including:
- React/React DOM, Lucide and Motion UI;
- browser audio transport, waveform, timeline, project persistence, undo/redo and crash recovery;
- browser-local ONNX ASR adapters and model installation;
- Companion Web client and Shahab local HTTP client;
- DSP and transcript/editing workflows.

The Web image currently uses `deploy/web/Dockerfile`, which runs `bun install --frozen-lockfile` against the root package manifest and root lock before `vite build`. The final Nginx image contains static output only; it does not contain the root Node dependency tree or server secrets.

The Vite config itself is a Node build/dev tool. It imports Vite, the React and Tailwind plugins, filesystem/path/crypto helpers, copies ONNX WASM assets, generates the release manifest, and configures the separate-mode API proxies. Those build-time Node imports must not be confused with browser bundle imports.

## 3. Local Audio Runtime dependency boundary

The root `server.ts` imports Express and Node built-ins, then wires several groups from root `src/`:
- ASR research/benchmark/streaming/router registries;
- local Core ASR and local processing orchestration;
- Companion IPC and Smart Audio Edit routes;
- Shahab local runtime and its HTTP router;
- local model artifact routing and Audio API security;
- platform/control-plane gateways and legacy compatibility routes.

Some platform-facing gateways are still wired through Express; they must be migrated by route and consumer contract, not by moving the whole Express server or all of `src/` into Fastify.

`scripts/start-api.ts` sets API-only environment flags and imports `server.ts`. Vite is now dynamically imported only in the legacy combined-server branch, so API-only mode does not initialize the Vite dev server.

`backend/Dockerfile.api` is a separate process/container image, but its build stage still installs the root Bun lock and copies root `src/` and `packages/`. This is deliberately recorded as **container separation, not dependency-graph separation**. It currently includes additional packages needed for the existing root runtime graph (for example Express and its type/runtime dependencies). Do not remove any of these until a transitive import graph proves they are unused by the server entrypoint.

## 4. Platform API dependency boundary

The production Platform API path is:
`backend/src/main.ts` → `backend/src/server.ts` → `BackendAuthAndPaymentService`, `BackendLicenseAndModelRevocationService`, `PlatformBackendServices`, and `DeviceSeatEnforcementService` / PostgreSQL transaction helpers.

The standalone manifest declares:
- `fastify` for HTTP;
- `pg` for PostgreSQL;
- `tsx` for the TypeScript executable in development and production image.

The standalone TypeScript/test scope intentionally includes the runnable production bootstrap and directly owned auth/license/database modules. Old ASR benchmark, CLI, ONNX-worker and `BackendApplicationFactory` experiments are not silently treated as production routes. Cross-runtime tests are executed through the root `test:separation` script.

The Dockerfile uses `npm ci` and requires `backend/package-lock.json`. The dedicated workflow attempts to generate that lockfile, run install/typecheck/tests, and build the image. The lockfile is currently absent because GitHub Actions has not allocated a runner and the available editing environment has no npm registry/cache access. Do not fabricate a lockfile or weaken the image to an unlocked install.

## 5. Current package ownership matrix

| Package/dependency family | Web build | Local Audio Runtime | Platform API |
|---|---:|---:|---:|
| React / React DOM / Lucide / Motion | Yes | No, unless a server-side module import proves otherwise | No |
| Vite / React plugin / Tailwind Vite plugin | Yes (build/dev only) | No in API-only runtime; lazy import only for legacy combined dev | No |
| ONNX Runtime Web | Yes, browser-local inference and WASM assets | Not assumed; prove via transitive graph before removal | No |
| Express | No in final Nginx runtime | Yes | No |
| Fastify | No | No | Yes |
| PostgreSQL `pg` | No | No unless a specific local route genuinely needs it | Yes |
| Node crypto/filesystem/path | Build tooling only | Yes | Yes |
| FFmpeg / `libgomp1` system packages | No | Required by the current local transcription/edit pipeline image | Not a substitute for local audio processing |

The table is a boundary target, not a list of already-separated lockfiles. The root manifest currently contains dependencies for both browser build and Express/runtime build, so installation is broader than the final Web runtime needs.

## 6. Safe extraction sequence

1. **Generate a machine-readable transitive import report** for the three entrypoints (`src/main.tsx`, `server.ts`, `backend/src/main.ts`). Include static imports, dynamic literal imports, package names, type-only imports, and cross-root references. Keep the report reproducible in CI.
2. **Create a Web build package** with only browser/build dependencies, while preserving the root source layout and all browser-local ASR/WASM assets. Generate and commit its lock from a real package manager run.
3. **Create a Local Audio Runtime package** from the actual `server.ts` transitive graph. Do not move browser ONNX, timeline, project, Companion or Audition modules until each consumer and environment contract is mapped. Generate its own lock and retain FFmpeg/native runtime dependencies.
4. Keep the Fastify Platform API package independent, generate/commit its npm lockfile, and prove its image builds from a clean checkout.
5. After each package split, run the package-specific build plus cross-runtime contract tests, local ASR/offline-license tests, and Companion/CEP tests. Keep the combined legacy image until a rollback drill passes.

## 7. Stop conditions

- No raw audio, transcript, local media path, Companion IPC or local project state may be sent to the Platform API as a side effect of packaging.
- Do not change the current production Ed25519 key identity or keyVersion in this package-split phase.
- Preserve P-256 device binding, secure local key storage, and paid offline entitlement through the paid subscription end.
- Preserve Audition CEP, Companion loopback/DNS-rebinding controls, timeline/EDL, preview/export, undo/redo and crash recovery.
- Do not claim independent package builds until their lockfiles exist and clean-checkout builds/tests actually pass.
