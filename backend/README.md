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

The package manifest declares the currently selected Fastify and `pg` versions. The dedicated GitHub workflow generates a standalone `package-lock.json`, then installs, typechecks, tests, and builds the image. That lockfile must be committed before production deployment; until then, the Dockerfile's install step is a provisional bootstrap, not a reproducible release lock.

This API has not yet taken ownership of overlapping Express routes. In particular, `POST /api/v1/license/lease` must not be switched until Ed25519 signature format, device binding, subscription expiry, offline entitlement, API response and client verification parity have all been tested.

The Platform API must never receive raw local audio or transcripts as a side effect of this separation. Browser-local ONNX, DSP, project/timeline/EDL, Companion and Audition functionality remain outside this package.
