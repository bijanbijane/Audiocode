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
3. Generate a **different Platform API Ed25519 key pair** for `PLATFORM_ED25519_*`; do not share or rotate the existing Express key during this migration.
4. Set `PLATFORM_DATABASE_URL` to the Compose PostgreSQL service, with a URL-encoded password that matches `POSTGRES_PASSWORD`.
5. Set `PUBLIC_CDN_BASE_URL` to the browser-visible `/platform-api` base, for example `http://localhost:8080/platform-api`.

Start the stack:

```bash
docker compose --env-file deploy/.env.separated -f deploy/docker-compose.separated.yml up --build -d
```

Open `http://localhost:8080`. The UI and local API ports are deliberately bound to host loopback only. The Express service remains a separate container, but shares the Web container's network namespace so Nginx reaches it at `127.0.0.1:3000`. This preserves the Local Audio Runtime's strict loopback/DNS-rebinding boundary; it is not a public hosted deployment recipe. Fastify/PostgreSQL remains a separate network service and is exposed only through `/platform-api/`.

The PostgreSQL init scripts run only when the named `pg_data` volume is first initialized. Existing databases require the repository's migration process; do not delete a live volume to force reinitialization.

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
- `HOST` (default `0.0.0.0`)
- `PORT` (default `4000`)
- `ADMIN_API_SECRET_KEY` (required for admin revocation operations)
- `MODEL_STORAGE_DIR` (default `/var/lib/paudio/models`)
- `ED25519_KEY_ID` (default `ed25519_prod_key_v1`)
- `PUBLIC_CDN_BASE_URL`
- `ENABLE_CLOUD_ASR` (must remain `false` under the current local-only ASR product policy)

Never put these values in Vite environment variables, browser code, static assets, or the Audition CEP bundle.

## Health checks

- `GET /healthz`: process liveness
- `GET /readyz`: PostgreSQL readiness

## Migration and release status

The executable entrypoint is `src/main.ts`. It calls the existing `bootstrapBackendServer` and handles SIGINT/SIGTERM graceful shutdown.

The package manifest declares the selected Fastify and `pg` versions. The dedicated GitHub workflow generates a standalone `package-lock.json`, installs with `npm ci`, typechecks, tests, and builds the image. The Platform API Dockerfile now requires `backend/package-lock.json` and uses `npm ci`; therefore a direct image build from a fresh checkout is intentionally blocked until the generated lockfile artifact is committed to this branch. Do not replace this with an unlocked production install.

Compatibility implementations now exist on the isolated `/platform-api/` ingress for `GET /api/v1/crypto/public-key`, `POST /api/v1/license/lease`, and `GET /api/v1/models/:modelId/manifest`. The lease response includes the legacy Ed25519 envelope fields understood by `src/security/OfflineCryptoVerifier.ts`, uses a PostgreSQL UUID, and sets offline expiry to `subscriptions.current_period_end` so paid access is not truncated by `offline_grace_hours`. The manifest alias reads model metadata/chunks from PostgreSQL and signs the legacy manifest shape. Source-level tests invoke the existing browser verifier for both responses, but have not executed in CI yet. Existing Express endpoints and consumers have not been switched; model chunk delivery parity and real authenticated login UI wiring are still required before cutover. The standalone API remains isolated under `/platform-api/` while this validation continues.

The Platform API must never receive raw local audio or transcripts as a side effect of this separation. Browser-local ONNX, DSP, project/timeline/EDL, Companion and Audition functionality remain outside this package.
