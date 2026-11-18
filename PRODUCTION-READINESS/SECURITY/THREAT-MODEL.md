# STRIDE 5x5 Threat Model & OWASP ASVS 5.0.0 Traceability (Phase 8)

| Threat ID | STRIDE Category | L x I = Score | Severity | Control Verified |
|---|---|---|---|---|
| `TM-01` | Elevation of Privilege (Cross-Tenant IDOR) | 4 x 5 = 20 | `CRITICAL` | `assertTenantIsolation` rejects cross-tenant reads/writes/deletes. |
| `TM-02` | Denial of Service (`ASR1` Frame Flood) | 4 x 4 = 16 | `HIGH` | Strict 24-byte `ASR1` validation, max size cap, even PCM16 check, bounded queues. |
| `TM-03` | Tampering (Spoofed Upload / Traversal) | 3 x 5 = 15 | `HIGH` | `validateUploadedAudioSecurity` rejects `..`, null bytes & invalid RIFF/WAVE magic. |
| `TM-04` | Info Disclosure (`local_only` Bypass / Secret Leak) | 3 x 5 = 15 | `HIGH` | 18-gate hard filter + `sanitizePublicErrorOutput` scrubs keys & paths. |
| `TM-05` | Tampering (Dataset Consent / Speaker Leak) | 3 x 5 = 15 | `HIGH` | 8-permission Consent Gate (`ALLOW_MODEL_TRAINING`) & speaker-disjoint split guard. |
| `TM-06` | Spoofing (Token Replay) | 3 x 4 = 12 | `MEDIUM` | Single-use nonce enforcement + Ed25519 asymmetric signatures. |
