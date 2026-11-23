# AvaPardaz Platform API

This package is the standalone Fastify/PostgreSQL Platform API. It is separate from:
- the React/Vite browser application;
- the existing Express Local Audio Runtime (root `server.ts`);
- the Adobe Audition CEP plugin and Companion process.

## Development

From the repository root:

```bash
npm install --prefix backend
npm run --prefix backend dev
```

The standalone API listens on `HOST` and `PORT` (defaults: `0.0.0.0:4000`).

For a production-style start:

```bash
npm run --prefix backend typecheck
npm run --prefix backend test
npm run --prefix backend start
```


## Three-container local deployment

A staging/local Compose topology is provided at `deploy/docker-compose.separated.yml`.

1. Copy `deploy/.env.separated.example` to `deploy/.env.separated`.
2. Preserve the **existing Express Ed25519 key pair** in the `LOCAL_ED25519_*` values.
3. Copy the **same currently deployed production Ed25519 key pair** and the exact current `ED25519_KEY_ID` into the `PLATFORM_ED25519_*` / `PLATFORM_ED25519_KEY_ID` values during this compatibility phase. Do not rotate the key, change the key ID or bump `keyVersion` until a versioned client-key discovery/cache migration is complete.
4. Set `PLATFORM_DATABASE_URL` to the Compose PostgreSQL service, with a URL-encoded password that matches `POSTGRES_PASSWORD`.
5. Set `PUBLIC_CDN_BASE_URL` to the browser-visible `/platform-api` base, for example `http://localhost:8080/platform-api`.

Start the stack:

```bash
docker compose --env-file deploy/.env.separated -f deploy/docker-compose.separated.yml up --build -d
```

Open `http://localhost:8080`. The Nginx/Web port is bound to host loopback. The containerized Express Local Audio Runtime port is intentionally **not** published to the host: `CompanionIpcBridge` validates the TCP peer address as true loopback, while Docker host-port NAT may present a bridge address. For Adobe Audition CEP/Companion on the host, run the native local runtime with `npm run dev:api` and keep it on `127.0.0.1:3000`; the Vite dev proxy uses that same loopback service. Do not weaken the Companion loopback check to make a Docker-published port appear to work. The Express service remains a separate container, but shares the Web container's network namespace so Nginx reaches it at `127.0.0.1:3000`. This preserves the Local Audio Runtime's strict loopback/DNS-rebinding boundary; it is not a public hosted deployment recipe. Fastify/PostgreSQL remains a separate network service and is exposed only through `/platform-api/`.

The Compose stack is for local-only operation, not a public Hosted deployment. The Express Local Audio Runtime is now a separate process/container and no longer eagerly imports Vite, but `backend/Dockerfile.api` still uses the root Bun dependency lock because the runtime imports the root `src/` module graph. A separate Local Audio Runtime package and lockfile remain a future migration gate.

The PostgreSQL init scripts run only when the named `pg_data` volume is first initialized. Existing databases require the repository's migration process; do not delete a live volume to force reinitialization. The cloud-ASR queue migration `migration_003_cloud_jobs.sql` is intentionally not mounted because server-side audio ingestion/inference remains disabled under the local-only ASR policy.

`backend/Dockerfile.platform-api` uses `npm ci` and requires the generated, committed `backend/package-lock.json`. Until that file is produced by CI and committed, the Platform API image build is intentionally blocked.

## Required server environment

The API fails closed during startup if any of these are missing:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `ED25519_PRIVATE_KEY_PEM` | Server-side signing key; secret, platform-only |
| `ED25519_PUBLIC_KEY_PEM` | Matching public key for verification |
| `PAYMENT_WEBHOOK_HMAC_SECRET` | Payment webhook authentication secret |

Optional runtime settings include:
- `HOST` (default `127.0.0.1` in development; `0.0.0.0` in production)
- `PORT` (default `4000`)
- `TRUST_PROXY` (default `false`; set `true` only behind the separated Nginx edge, which overwrites forwarded client-IP headers)
- `PLATFORM_API_INTERNAL_ORIGIN` (required by Hosted Express compatibility facades; private service origin such as `http://avapardaz-platform-api:4000`, never client-controlled)
- `ADMIN_API_SECRET_KEY` (required for admin revocation operations)
- `MODEL_STORAGE_DIR` (default `/var/lib/paudio/models`)
- `ED25519_KEY_ID` (local code fallback `ed25519_prod_key_v1`; separated Compose requires the exact existing production value)
- `PUBLIC_CDN_BASE_URL`
- `ENABLE_CLOUD_ASR` (must remain `false` under the current local-only ASR product policy)

Never put these values in Vite environment variables, browser code, static assets, or the Audition CEP bundle.



## Express Hosted compatibility adapter

The root Express Local Audio Runtime uses the server-only `PLATFORM_API_INTERNAL_ORIGIN` variable to forward the legacy public-key, lease and model-manifest URLs to the Fastify service in Hosted mode. Do not expose this variable to Vite or the browser. The local Compose stack sets it to `http://avapardaz-platform-api:4000` on the private Docker network.

## Health checks

- `GET /healthz`: process liveness
- `GET /readyz`: PostgreSQL readiness

## Migration and release status

The executable entrypoint is `src/main.ts`. It calls the existing `bootstrapBackendServer` and handles SIGINT/SIGTERM graceful shutdown.

The standalone package intentionally typechecks and runs only the production Fastify bootstrap, auth/payment, license/device-seat, PostgreSQL transaction modules, and their direct tests. The root-level integration command `npm run test:separation` additionally exercises the browser verifier, Vite/Nginx proxy, Compose boundaries, and Express loopback policy. Older benchmark/ASR-worker/CLI utilities under `backend/src/asr-worker`, `backend/src/cli`, and the unused `BackendApplicationFactory` are not part of the executable Platform API package test graph; they remain in the monorepo and must not be mistaken for live Platform API endpoints. Cross-runtime/browser compatibility tests are run from the root `test:separation` command instead.

The package manifest declares the selected Fastify and `pg` versions. The dedicated GitHub workflow generates a standalone `package-lock.json`, installs with `npm ci`, typechecks, tests, and builds the image. The Platform API Dockerfile now requires `backend/package-lock.json` and uses `npm ci`; therefore a direct image build from a fresh checkout is intentionally blocked until the generated lockfile artifact is committed to this branch. Do not replace this with an unlocked production install.

Hosted Express compatibility facades now forward the legacy `GET /api/v1/crypto/public-key`, `POST /api/v1/license/lease`, and `GET /api/v1/models/:modelId/manifest` paths to the internal Fastify API; Local mode retains the local demo signer. Fastify issues the legacy Ed25519 envelope understood by `src/security/OfflineCryptoVerifier.ts`, uses a PostgreSQL UUID and sets offline expiry to `subscriptions.current_period_end` so paid access is not truncated by `offline_grace_hours`. The legacy adapter strips client plan/grace overrides and hashes older raw device fingerprints server-side; Fastify independently recomputes SHA-256 and constant-time compares a raw/hash pair before signing. Keep the existing production Ed25519 key pair and keyVersion unchanged in both runtimes until a versioned client key-discovery/cache migration is complete. Model manifests come from PostgreSQL and are signed in the old client shape. Chunk delivery requires a registered chunk row, live non-revoked release status, storage-root confinement, exact metadata length and SHA-256 verification before sending any bytes. Source tests use the existing browser verifier and cover paid expiry, tampering, revocation and chunk integrity, but have not executed in CI. The new `PlatformApiClient.ts` is not yet connected to a real login/account screen; PostgreSQL integration and the full deployment build remain unverified.

The Platform API must never receive raw local audio or transcripts as a side effect of this separation. Browser-local ONNX, DSP, project/timeline/EDL, Companion and Audition functionality remain outside this package.

The native Fastify API lease endpoint accepts a 64-character SHA-256 `deviceFingerprintHash`. The legacy Express adapter may accept an older raw device fingerprint, but hashes it in process and Fastify independently verifies the raw/hash pair; only the digest is written to PostgreSQL. The browser client does not invent or trust a raw hardware identifier; the caller must use the approved local device-binding component and pass its established hash. `OfflineLicenseCard.tsx` is a demo fixture containing a synthetic `browser_fp_opfs_01` value and hard-coded demo identity/plan; it must not be wired to production login or license issuance.
