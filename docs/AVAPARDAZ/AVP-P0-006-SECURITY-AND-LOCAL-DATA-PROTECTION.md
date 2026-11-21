# AVP-P0-006 — Security Hardening, Local Data Protection & Software Supply-Chain Integrity

**Status:** `VERIFIED (12/13 TRUST BOUNDARIES VERIFIED; SIGNING KEY & LOCKFILE CVE SCAN BLOCKERS LOGGED)`  
**Primary Modules & Registers:**
- `src/security/SecurityTrustBoundaryGuards.ts`
- `src/security/ArchitectureAndSecurityGuardrails.test.ts`
- `docs/AVAPARDAZ/security-acceptance-register.json`

---

## 1. Enforced Security Controls Across 13 Trust Boundaries

1. **Untrusted Project Payload Validation (`validateUntrustedProjectPayload`):** Rejects `__proto__`, `constructor`, and `prototype` keys at any depth, caps JSON nesting depth and array/string sizes, and rejects `NaN`/`Infinity` numeric payloads.
2. **Audio Decoder Resource Bounds (`validateAudioDecoderResourceBounds`):** Enforces maximum byte size, duration, sample-rate allowlist, channel ceiling, and magic-header validation prior to decode.
3. **Symlink-Aware Filesystem Confinement (`assertPathWithinAllowedRoot`):** Resolves `realpath` symlinks and rejects any path escaping the permitted workspace/staging root.
4. **Loopback Companion IPC Hardening:** Strict `127.0.0.1` binding, DNS-rebinding `Host` checks, `Origin` CSRF allowlist, HMAC-SHA256 authentication, nonce replay cache, `request_id` deduplication, and `expires_at_ms` expiration.
5. **Privacy-Preserving Log Sanitizer (`sanitizeLogMessage`):** Automatically redacts Bearer tokens, HMAC/API secrets, raw transcript snippets, and local user filesystem paths before diagnostic output.
6. **Static Architecture & Supply-Chain Guardrails:** Verified 0 bundled `.onnx`/`.bin`/`.pt` weights in `src/` or `public/`, 0 hardcoded secrets, and 0 cloud ASR endpoints in `BrowserOnnxAsrRuntimeAdapter.ts`.

## 2. Verified Automated Evidence

- `src/security/ArchitectureAndSecurityGuardrails.test.ts`: **4 / 4 PASS**.
- `src/host-bridge/companion/__tests__/LocalCompanionAndSecurity.test.ts`: **8 / 8 PASS**.
- Full boundary inventory in `docs/AVAPARDAZ/security-acceptance-register.json`.
