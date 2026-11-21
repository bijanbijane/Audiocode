# SHAHAB Operational Architecture (SHAHAB-014)

- **SHAHAB-013 Entry Gate:** `PARTIALLY_VERIFIED` (automatic production rollout disabled because external Ed25519 signing infrastructure is not provisioned).
- **Observability:** 25 typed operational events in `src/shahab/ShahabOperationsGovernance.ts` with strict PII/audio/transcript exclusion.
- **Privacy:** Local operational telemetry by default; external telemetry disabled by default with granular revocable consent.
