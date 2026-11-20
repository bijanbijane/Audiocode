# AVAPARDAZ — PHASE-12: SECURITY, PRIVACY & RED-TEAM AUDIT DECISION

**Document ID:** `AVP-P12-SEC-1.0`  
**Date:** `2026-11-20`  
**Audit Scope:** Local Companion IPC (`LocalCompanionService.ts`), Offline ASR Subprocess (`LocalSherpaNeuralEngine.ts`), Web App & Server (`server.ts`, `App.tsx`), Adobe Audition CEP Panel (`packages/audition-cep-plugin/`), Supply Chain & Secret Hygiene.  
**Verdict:** **`CONDITIONALLY CLEARED FOR INTERNAL ALPHA — BLOCKED FOR PUBLIC COMMERCIAL RELEASE`** (pending code signing, `package-lock.json` dependency audit, and physical OS sandbox testing).

---

## 1. Threat Model & Attack Surface Verified

| Threat ID | Attack Vector | Mitigation Implemented | Verification Evidence (`[TESTED]`) | Status |
| :--- | :--- | :--- | :--- | :---: |
| `SEC-01` | **Unauthorized Audio Upload / Silent Cloud Fallback** | `@google/genai` removed from `server.ts`; `/api/v1/asr/transcribe` & `/api/v1/asr/cloud-consents` return `HTTP 410 Gone`; `LocalExecutionPolicy` enforces `allowCloudAsr: false`, `allowAudioUploadForArs: false`. | `LocalOnlyExecutionPolicy.test.ts`, `AsrNetworkIsolation.test.ts`, Playwright `0` external calls. | `PASS` |
| `SEC-02` | **ASR Process Network Egress During Inference** | `LocalSherpaNeuralEngine` & CPU benchmark harness spawn `sherpa-onnx-offline` with strict proxy blackhole (`http_proxy=127.0.0.1:9`, `https_proxy=127.0.0.1:9`, `ALL_PROXY`, `HF_HUB_OFFLINE=1`). | All 5 benchmarked ONNX models + live Companion HTTP test #6 succeeded offline (`offline_verified: true`). | `PASS` |
| `SEC-03` | **DNS Rebinding Attack Against Local Companion** | `isAllowedLoopbackHostHeader()` rejects any non-loopback `Host` header (`evil.com:47291`, `127.0.0.1.evil.com`). | Red-Team Test #5 & #6 (`LocalCompanionAndSecurity.test.ts`) -> `HTTP 403`. | `PASS` |
| `SEC-04` | **Cross-Site Request Forgery (CSRF) from Malicious Website** | `isAllowedCompanionOrigin()` rejects untrusted browser `Origin` headers (e.g., `https://attacker.example`). | Red-Team Test #5 & #6 -> `HTTP 403`. | `PASS` |
| `SEC-05` | **Unauthorized IPC / Replay Attacks** | `CompanionIpcBridge` enforces session handshake (`v2.0.0`), HMAC-SHA256 request signing, timestamp skew window, and single-use nonce tracking. | Red-Team Test #6: unauthenticated request -> `401`; replayed nonce -> `409`; contract mismatch -> `409`. | `PASS` |
| `SEC-06` | **Arbitrary Local File Read / Path Traversal via `filePath`** | `validateLocalAudioFilePath()` blocks `..`, NUL bytes, non-audio extensions (`.env`, `/etc/passwd`), and non-existent paths. | Red-Team Test #5 & #6 (`../../etc/passwd.wav`, `/etc/passwd`) -> `HTTP 403`. | `PASS` |
| `SEC-07` | **Malformed / Corrupt Audio Crash (DoS)** | `CoreAudioIngestion` + `ffmpeg` decode catch malformed headers cleanly and transition job to `FAILED` without crashing Companion process. | Red-Team Test #6 (corrupt WAV payload -> clean `FAILED` status, server stays healthy). | `PASS` |
| `SEC-08` | **XSS / Script Injection via Crafted Audio Filename or Transcript** | CEP panel (`client/app.js`) renders all filenames/transcripts via `textContent` (zero `innerHTML` with untrusted strings) + strict CSP (`default-src 'self'`). | Automated Test #7 + static inspection of `client/index.html` & `client/app.js`. | `PASS` |
| `SEC-09` | **Temp Audio Residual Leakage & Transcript Logging** | Temp ingestion dirs created per job under `os.tmpdir()/avapardaz-ingest-*` and deleted in `finally` blocks; zero transcript text written to logs. | Code inspection (`LocalSherpaNeuralEngine.ts`, `LocalCompanionService.ts`). | `PASS` |
| `SEC-10` | **Hardcoded Secrets / API Keys in Repository** | Static regex grep across `src/`, `packages/`, `companion/`, `server.ts`. | `0` real API keys, tokens, or private keys found. | `PASS` |

---

## 2. Supply-Chain & Residual Security Findings (Honest Reporting)

| Severity | Finding | Observed Evidence | Required Fix Before Public Launch |
| :---: | :--- | :--- | :--- |
| **`P1` (Blocker for Commercial Release)** | **`npm audit` Failed (`ENOLOCK`)** | Repository contains `bun.lock` (`122 KB`) and no `package-lock.json`; running `npm audit --omit=dev` exited with `ENOLOCK`. Dependency CVE posture is therefore **UNVERIFIED**. | Generate and commit a canonical lockfile (`package-lock.json` or run `bun audit` / Trivy / OSV-Scanner in CI) and remediate all Critical/High CVEs. |
| **`P1` (Blocker for Commercial Release)** | **Unsigned Binaries & CEP Debug Mode** | CEP plugin currently requires `PlayerDebugMode=1`; Companion daemon has no Apple Developer ID notarization or Windows Authenticode signature. | Sign `.zxp` via `ZXPSignCmd` and sign/notarize macOS/Windows Companion executables. |
| **`P2` (Important)** | **Unencrypted Loopback HTTP on Shared Multi-User Machines** | Loopback `127.0.0.1` is unencrypted to local root/privileged processes on the same host (standard for local IPC, mitigated by per-session HMAC secret). | Bind per-user ephemeral port + Unix domain socket / Windows named pipe option in v1.1 hardening. |
| **`P2` (Important)** | **Pre-existing Legacy Test Suite TS Debt (`8` stale `.test.ts` files)** | `tsc --noEmit` reports errors exclusively in 8 legacy Phase-00 test files (zero errors in production or Phase-01..15 code). | Repair or retire legacy stale test files before enabling strict CI release gate. |
