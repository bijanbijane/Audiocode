# AVP-P0-004 — Adobe Audition CEP ↔ Native Companion Integration & Production-Grade IPC

**Status:** `VERIFIED (LOOPBACK IPC, LIFECYCLE, CHUNK TRANSFER & CEP HYGIENE VERIFIED; LIVE AUDITION HOST GUI BLOCKED IN LINUX CONTAINER)`  
**Primary Modules:**
- `src/host-bridge/companion/CompanionLifecycleManager.ts`
- `src/host-bridge/companion/CompanionAudioTransfer.ts`
- `src/host-bridge/companion/CompanionIpcBridge.ts`
- `src/host-bridge/companion/LocalCompanionService.ts`
- `companion/avapardaz-companion.ts`
- `packages/audition-cep-plugin/jsx/auditionHost.jsx`
- `packages/audition-cep-plugin/client/app.js`

---

## 1. Production IPC & Lifecycle Capabilities

1. **12-State Companion Lifecycle & Single-Instance Lock (`CompanionLifecycleManager.ts`):** Manages deterministic startup, lock acquisition, stale-PID detection & recovery, health transitions, graceful drain, and shutdown without zombie processes.
2. **Hardened Loopback IPC (`CompanionIpcBridge.ts` & `LocalCompanionService.ts`):**
   - Binds strictly to `127.0.0.1` with Host DNS-rebinding & Origin CSRF allowlist enforcement.
   - Enforces HMAC-SHA256 authentication, nonce replay rejection, correlation `request_id` deduplication, `expires_at_ms` TTL expiration, concurrency caps, and a canonical 17-code error taxonomy.
   - Supports `JOB_LIST`, `JOB_RECONNECT`, and job cancellation across panel reloads or reconnects.
3. **Sequenced Chunked Audio Transfer (`CompanionAudioTransfer.ts`):** Validates PCM/WAV metadata, enforces strict chunk ordering and size bounds, verifies per-chunk and complete-stream SHA-256 checksums, rejects duplicates/truncation, and cleans up temporary buffers.
4. **Adobe Audition CEP Source Identity Binding (`auditionHost.jsx` & `app.js`):** Binds active Audition document identity (`filePath`, `fileSizeBytes`, `fileModifiedMs`), supports `JOB_RECONNECT`, and rejects stale transcription results with `SOURCE_CHANGED` if the active Audition clip changes mid-job.

## 2. Verified Automated Evidence

- `src/host-bridge/companion/__tests__/CompanionProductionIpcAndCep.test.ts`: **3 / 3 PASS**.
- `src/host-bridge/companion/__tests__/LocalCompanionAndSecurity.test.ts`: **8 / 8 PASS**.

## 3. Explicit Blocker

- **`BLK-004`:** Physical macOS/Windows Adobe Audition 24/25 host GUI is unavailable in this Linux container; live ExtendScript marker insertion and `.zxp` code-signing remain externally blocked.
