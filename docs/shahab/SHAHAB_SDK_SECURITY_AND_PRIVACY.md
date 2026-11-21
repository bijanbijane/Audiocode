# SHAHAB SDK Security & Privacy Boundary

- Local-first default; `CLOUD` without `explicitCloudConsent: true` throws `CONSENT_REQUIRED`.
- `FILE_BACKED_WAV` confined strictly within `authorizedWorkspaceRoot` (escape throws `AUTHORIZATION_FAILURE`).
- Project/tenant separation enforced on job queries, idempotency keys, and cancellation.
