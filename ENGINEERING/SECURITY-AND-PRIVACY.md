# SECURITY, PRIVACY & SECRET REDACTION POLICY — PHASE 3, PHASE 5 & PHASE 14 HARDENING

**Document Version:** `2.0.0-hardened`

---

## 1. Secret Management & Redaction (`sanitizeSecretsFromText`)
- API keys (`ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `GEMINI_API_KEY`), `Bearer` tokens, `xi-api-key` headers, and query-string `token=` values are automatically scrubbed via `sanitizeSecretsFromText()` before any error message or log entry is stored or returned.
- No UI input field for entering raw commercial API keys is exposed in the client browser; external provider calls route strictly through `/api/v1/...` server endpoints.
- Local crash recovery checkpoints (`src/runtime/RecoveryCheckpointSchema.ts`) reject any payload containing forbidden credential/secret fields or embedded raw audio buffers before persistence.

## 2. Server-Side Authentication, RBAC & Tenant Isolation (`AuthorizationPolicyEngine`)
- **Zero Client-Controlled Roles:** `x-avapardaz-role` headers, query `?role=` parameters, and request body `actorRole`/`approverRole`/`approverId` fields are never trusted for authorization. Forged provenance fields on Model Factory governance endpoints are explicitly rejected (`DENIED_FORGED_PROVENANCE_FIELD`).
- **Fail-Closed Membership Resolution:** `PlatformControlPlaneService.authenticateApiKeyRequest()` enforces active organization, active project, active user account, non-expired/non-revoked credential, and **exactly one** active organization membership (0 memberships -> denied; >1 ambiguous memberships -> denied).
- **Independent Role + Scope Enforcement:** Every `/v1/security/*` (10 operations) and `/v1/ml/*` (12 operations) route requires both an authorized verified `OrganizationRole` and an explicit least-privilege credential scope via `src/security/AuthorizationPolicyEngine.ts`.
- **Cross-Tenant Boundary Protection:** Cross-tenant hints (`x-tenant-id`, `x-organization-id`, query/body `tenantId`/`organizationId`) and cross-tenant resource references (recordings, models, evaluations, packages, deployments) are rejected with `403` before any state mutation.
- **Auditability:** Denied authorization attempts and Model Factory governance decisions record the verified server-side `principalId` and `role` without logging secrets or bearer tokens.

## 3. Streaming Authentication & Ephemeral Privacy
- **Single-Use Short-Lived Session Tokens:** WebSocket sessions require a single-use token (`TTL = 30s`) issued by `POST /api/v1/streaming/sessions`. Reused or expired tokens are rejected with `STREAM_AUTH_FAILED` / `STREAM_SESSION_EXPIRED`.
- **Default Ephemeral Audio Policy (`privacy_mode = "ephemeral"`):** Raw audio frames are processed in bounded memory buffers and discarded immediately after utterance finalization. Diagnostic frame metadata is retained only when `privacy_mode = "diagnostic_opt_in"` and `retain_audio = true`.

## 4. External Infrastructure Boundaries
- External OIDC/SCIM identity providers, managed PostgreSQL RLS enforcement, and external KMS/HSM services are **not** active in the local-first container runtime and are tracked separately under external infrastructure milestones.
