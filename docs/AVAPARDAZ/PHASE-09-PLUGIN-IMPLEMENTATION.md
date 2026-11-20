# AVAPARDAZ — PHASE-09: ADOBE AUDITION PLUGIN & WEB APP SHARED INTEGRATION

**Document ID:** `AVP-P09-IMPL-1.0`  
**Date:** `2026-11-20`  
**Status:** `IMPLEMENTED (HOST GUI UNVERIFIED IN LINUX CONTAINER)`

---

## 1. Unified Core Principle (Zero Duplicate Engines)

Both user-facing products call the exact same central backend engine and contract (`CANONICAL_CONTRACT_VERSION = '2.0.0'`):

| Layer | Implementation File | Consumed By |
| :--- | :--- | :--- |
| **Neural CPU Inference Engine** | `src/asr-core/LocalSherpaNeuralEngine.ts` | Shared Companion Daemon & Express `/api/v2/companion` |
| **Long-Audio `O(1)` Streaming Pipeline** | `src/asr-core/LongAudioChunkedPipeline.ts` | Shared Companion (handles 10s -> 60m+ files with energy-valley chunking & Persian seam dedup) |
| **Subtitle & Transcript Exporter** | `src/utils/subtitleExporter.ts` | Shared Companion (`EXPORT_TRANSCRIPT`) + Web App (`TXT`, `SRT`, `VTT`, `JSON`) |
| **Hardened Loopback Companion Service** | `src/host-bridge/companion/LocalCompanionService.ts` | Standalone Daemon (`companion/avapardaz-companion.ts`) + Dev Server (`server.ts`) |
| **Product A: Adobe Audition CEP Panel** | `packages/audition-cep-plugin/` (`manifest.xml`, `auditionHost.jsx`, `client/app.js`) | Adobe Audition 22.0+ (macOS / Windows) |
| **Product B: AVAPARDAZ Web Client** | `src/host-bridge/companion/CompanionWebClient.ts` + `src/App.tsx` | Browser Web Application (connects to Shared Local Companion when available; fails closed otherwise) |

---

## 2. Features Implemented in Adobe Audition CEP Panel (`packages/audition-cep-plugin/client/app.js`)

1. **Companion Discovery & Secure Handshake (`v2.0.0`):** Probes `/health`, negotiates HMAC-SHA256 session secret via Web Crypto API, and displays explicit online/offline Companion state.
2. **Host Audio Import (`jsx/auditionHost.jsx`):** Queries active Adobe Audition document path or lets the user select a local file path, submitting only the local path (`filePath`) to Companion — zero audio duplication or cloud transfer.
3. **Language & Model Selection:** Supports Persian (`fa` -> `Reza2kn/Shenava-Rizeh` fast CPU specialist), English (`en` -> `Whisper large-v3-turbo`), or Bilingual/Auto (`fa-en`), with live progress bar and instant `AbortSignal` (`SIGKILL`) job cancellation.
4. **RTL Persian Transcript Editor:** XSS-safe `textContent` rendering, inline segment editing, live search, find & replace, segment split & merge, multi-level Undo/Redo stack, and honest timestamp display (never fabricates word timestamps when model only yields segments).
5. **Audition Timeline Sync Hooks:** Click-to-seek playhead and marker export hooks wired to `CSInterface.evalScript()` -> `auditionHost.jsx` (flagged `IMPLEMENTED BUT NOT VERIFIED` pending physical macOS/Windows Adobe Audition execution).
6. **Multi-Format Export & Model Memory Control:** UTF-8 `TXT`, `SRT`, `VTT`, and `JSON` export plus explicit `MODEL_UNLOAD` button to release RAM immediately.

---

## 3. Web App Integration (`src/App.tsx` + `CompanionWebClient.ts`)

- `server.ts` mounts `localCompanionService.createExpressRouter()` at `/api/v2/companion` **prior** to global `express.json()` so large local audio buffers are handled cleanly with strict Host/Origin/HMAC guards.
- `handleRunPersianAsr` in `src/App.tsx` checks live Companion availability via `CompanionWebClient` (`v2.0.0`):
  - When a verified local neural model is installed in Companion, it submits the audio locally over loopback HMAC IPC, tracks real progress, and loads real neural transcript segments + honest word/segment timestamps into the Studio editor.
  - When no local Companion/model is installed, it fails closed with `LOCAL_ASR_MODEL_NOT_INSTALLED` (zero cloud fallback, zero synthetic placeholder words).
