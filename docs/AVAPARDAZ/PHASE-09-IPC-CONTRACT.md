# AVAPARDAZ — PHASE-09: SHARED LOCAL COMPANION IPC CONTRACT

**Document ID:** `AVP-P09-IPC-1.0`  
**Date:** `2026-11-20`  
**Canonical Contract Version:** `2.0.0` (`CANONICAL_CONTRACT_VERSION` in `src/processing-engine/capabilities/CanonicalCapabilityContracts.ts`)  
**Status:** `IMPLEMENTED AND VERIFIED` (Live HTTP + HMAC + Real Offline ASR Test Suite `7/7` PASS)

---

## 1. Transport & Security Invariants

| Invariant | Implementation (`src/host-bridge/companion/LocalCompanionService.ts`) | Verification Status |
| :--- | :--- | :---: |
| **Loopback-Only Binding** | Daemon (`companion/avapardaz-companion.ts`) binds strictly to `127.0.0.1:47291` (rejects non-loopback `remoteAddress`). | `VERIFIED` |
| **DNS Rebinding Protection** | `isAllowedLoopbackHostHeader()` allows only `localhost`, `127.0.0.1`, `[::1]` (optional port). Any spoofed `Host` header returns `403`. | `VERIFIED` (`Red-Team Test #5/#6`) |
| **Strict Origin CSRF Guard** | `isAllowedCompanionOrigin()` allows only local loopback origins, `file://`, `cep://`, or absent `Origin` (non-browser). Untrusted web origins return `403`. | `VERIFIED` (`Red-Team Test #5/#6`) |
| **Authenticated Session Handshake** | `POST /handshake` validates `expected_contract_version === '2.0.0'` and issues a cryptographically random `session_id` + `session_secret`. | `VERIFIED` (`HTTP 409` on version mismatch) |
| **HMAC-SHA256 + Nonce Replay Guard** | Every `POST /request` envelope requires `X-Avapardaz-Session` & HMAC-SHA256 signature over canonical payload + timestamp + unique `nonce`. Replayed nonces return `409`; missing/invalid auth returns `401`. | `VERIFIED` (`Red-Team Test #6`) |
| **Local File Path Guard** | `validateLocalAudioFilePath()` blocks `..` traversal, NUL bytes, non-audio extensions (`.sh`, `.env`, `/etc/passwd`), and requires existing local file with allowed audio extension. | `VERIFIED` (`Red-Team Test #5/#6`) |
| **Zero Transcript Logging** | Companion logs job IDs, timing, and error codes only — never audio payloads or transcript text. | `VERIFIED` (Code inspection) |

---

## 2. Endpoints (Mounted at `/api/v2/companion` & Standalone `:47291`)

| Method & Path | Auth | Purpose |
| :--- | :---: | :--- |
| `GET /health` | None (Loopback + Host/Origin guarded) | Returns companion readiness, contract version (`2.0.0`), local-only enforcement, and discovered installed neural models (`LocalSherpaNeuralEngine`). |
| `POST /handshake` | Loopback + Host/Origin guarded | Negotiates `client_id`, `host_type` (`AUDITION_CEP` / `WEB_APP`), `expected_contract_version: "2.0.0"` -> returns `session_id`, `session_secret`, `expires_at`. |
| `POST /request` | Session HMAC-SHA256 + Nonce | Unified JSON-RPC envelope supporting operations below. |

### Supported `POST /request` Operations

1. **`CAPABILITY_LIST`**: Returns installed neural model profiles (`Reza2kn/Shenava-Rizeh`, `openai/whisper-large-v3-turbo-int8`, `openai/whisper-base-fp32`, etc.), runtime availability, and export capabilities.
2. **`HOST_CAPABILITY_MATRIX`**: Returns verified host/device constraints and local-only policy flags.
3. **`JOB_SUBMIT`**: Accepts either:
   - `{ filePath, language, modelId?, chunkSeconds? }` (Adobe Audition CEP local file reference — zero binary upload), OR
   - `{ audioBase64, fileName, language, modelId? }` (Browser Web App local loopback transfer when OPFS/File API hands off bytes to Companion).
   Returns `{ jobId, status: "QUEUED" | "RUNNING" }`.
4. **`JOB_STATUS`**: Polls live progress (`0..100%`), stage (`INGEST`, `CHUNKING`, `INFERENCE`, `COMPLETED`, `CANCELLED`, `FAILED`), elapsed time, honest timestamp granularity (`WORD` vs `SEGMENT`), and canonical `transcriptResult`.
5. **`JOB_CANCEL`**: Triggers `AbortController.abort()` -> sends `SIGKILL` to active `sherpa-onnx-offline` child process and cleans up temporary chunk files immediately.
6. **`CAPABILITY_EXECUTE`**:
   - `MODEL_UNLOAD`: Releases active model handle and clears temp directories.
   - `EXPORT_TRANSCRIPT`: Renders UTF-8 `TXT`, `SRT`, `VTT`, or `JSON` using shared `src/utils/subtitleExporter.ts`.

---

## 3. Shared Client Parity (Audition Plugin + Web App)

- **Product A (Adobe Audition CEP):** `packages/audition-cep-plugin/client/app.js` connects to `http://127.0.0.1:47291` (configurable loopback port) via Web Crypto `SubtleCrypto` HMAC-SHA256.
- **Product B (AVAPARDAZ Web App):** `src/host-bridge/companion/CompanionWebClient.ts` connects to `/api/v2/companion` (or local Companion loopback) with the exact same `2.0.0` HMAC contract, wired into `src/App.tsx` (`handleRunPersianAsr`). When no local Companion/model is installed, the Web App fails closed with an honest local-only status (`LOCAL_ASR_MODEL_NOT_INSTALLED`) and **never** falls back to cloud APIs or synthetic transcripts.
