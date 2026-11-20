# AVAPARDAZ — LOCAL-ONLY EXECUTION & ZERO CLOUD ASR VERIFICATION (`AVP-P01-006`)

**Document ID:** `AVP-P01-LOCAL-001`  
**Phase:** `PHASE-01` — Local Runtime Foundation & Memory-Safe Audio Pipeline (`MASTER v3.1`)  
**Date:** `2026-11-20`  
**Status:** `VERIFIED`

---

## 1. Local-Only Policy Enforcement (`src/runtime/LocalExecutionPolicy.ts`)

Created `src/runtime/LocalExecutionPolicy.ts` defining the immutable production runtime policy (`AVAPARDAZ_LOCAL_EXECUTION_POLICY`):

- `allowCloudAsr: false`
- `allowAudioUploadForAsr: false`
- `allowFakeTranscriptFallback: false`
- `allowSilentCloudFallback: false`
- `evaluateLocalAsrExecutionReadiness()`: deterministically rejects cloud mode (`LOCAL_ONLY_CLOUD_ASR_BLOCKED`), missing weights (`LOCAL_ASR_MODEL_NOT_INSTALLED`), or uninitialized local runtime (`LOCAL_ASR_MODEL_NOT_READY`) with honest Persian/English messages and **zero fabricated transcript words**.
- `assertLocalOnlyNetworkRequest()` & `createLocalOnlyFetchGuard()`: blocks any request targeting `/api/v1/asr/transcribe`, Gemini/Google Generative Language endpoints, OpenAI, Deepgram, ElevenLabs, or cross-origin audio upload endpoints.

---

## 2. Server-Side Cloud ASR Decommissioning (`server.ts`)

- Removed `@google/genai` import and live `createStudioCloudAsrRouter` Gemini invocation from `server.ts`.
- Mounted explicit **`HTTP 410 Gone`** handlers on `ALL /api/v1/asr/transcribe` and `ALL /api/v1/asr/cloud-consents` returning:
  ```json
  {
    "error": "LOCAL_ONLY_ASR_POLICY_ENFORCED",
    "code": "LOCAL_ONLY_CLOUD_ASR_BLOCKED",
    "localOnlyEnforced": true
  }
  ```
- Updated `GET /api/v1/asr/health` to report:
  `releaseStatus: "PHASE_01_LOCAL_FOUNDATION"`, `localOnlyEnforced: true`, `cloudGeminiAsrConfigured: false`, `cloudAsrEnabled: false`.
- **Legacy Preservation Note:** `src/security/CloudAsrConsentRegistry.ts` remains untouched in the repository solely so legacy security/consent unit tests continue passing, while `server.ts` no longer mounts or executes it.

---

## 3. Client-Side Studio UI Decoupling (`src/App.tsx`)

- Removed startup `fetch('/api/v1/asr/health')` call so launching the studio emits **zero** ASR backend requests.
- Locked `cloudAsrConfigured = false`.
- Completely removed `executeCloudGeminiAsr`, `handleRunCloudGeminiAsr`, and every reference to `/api/v1/asr/transcribe` from `src/App.tsx`.
- Updated `handleRunPersianAsr()` to route through `evaluateLocalAsrExecutionReadiness()`, halting honestly with `LOCAL_ASR_MODEL_NOT_INSTALLED` / `LOCAL_ONLY_CLOUD_ASR_BLOCKED` and generating **zero** fake or placeholder Persian transcripts.

---

## 4. Verification Evidence (`[TESTED]`)

| Verification Check | Method | Observed Result |
| :--- | :--- | :--- |
| **Unit Policy Tests** | `npx --yes tsx --test src/runtime/LocalOnlyExecutionPolicy.test.ts` | **PASS** — blocks cloud ASR, missing model, and unready runtime; zero fake transcripts |
| **Network Isolation & Static Code Audit** | `npx --yes tsx --test src/runtime/AsrNetworkIsolation.test.ts` | **PASS** — confirms `src/App.tsx` and `server.ts` contain zero `@google/genai` / Gemini ASR calls and zero live `/api/v1/asr/transcribe` invocations |
| **Live HTTP `GET /api/v1/asr/health`** | `curl http://localhost:3000/api/v1/asr/health` | `HTTP 200`, `localOnlyEnforced: true`, `cloudGeminiAsrConfigured: false`, `cloudAsrEnabled: false` |
| **Live HTTP `POST /api/v1/asr/transcribe`** | `curl -X POST http://localhost:3000/api/v1/asr/transcribe` | `HTTP 410 Gone`, `code: "LOCAL_ONLY_CLOUD_ASR_BLOCKED"` |
| **Live Chromium Browser Audit** | `playwright-cli` (`http://localhost:3000`, `1440x900`) | **0 dynamic API/external requests**, **0 console errors**; top bar honestly displays `محلی (پیش‌فرض)`, `مدل محلی نصب نشده`, `0.0 MB / 1024.0 MB (NORMAL)` |
