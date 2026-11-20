# AVAPARDAZ — PHASE-09: ADOBE AUDITION PLUGIN ARCHITECTURE

**Document ID:** `AVP-P09-ARCH-1.0`  
**Date:** `2026-11-20`  
**Status:** `IMPLEMENTED (HOST GUI UNVERIFIED — LINUX CONTAINER)`

---

## 1. Official Adobe Audition Extensibility Verification (`[OBSERVED]`)

Based on official Adobe Creative Cloud / Audition developer documentation verified in this session:

| Platform / API | Official Support in Adobe Audition (2025/2026) | Engineering Decision |
| :--- | :---: | :--- |
| **CEP (Common Extensibility Platform)** (`Host Name="AUDT"`) + ExtendScript (`.jsx`) | **SUPPORTED** (Official interactive panel platform for Audition) | **SELECTED** (`CSXS/manifest.xml`, CEP 11, `AUDT [22.0,99.9]`) |
| **UXP (Unified Extensibility Platform)** | **NOT SUPPORTED** in Adobe Audition (UXP targets Photoshop, Premiere Pro, InDesign, Illustrator) | **REJECTED** (Do not build fake UXP manifests for Audition) |
| **VST3 / AU Audio Effect Plugins** | Supported for real-time DSP audio processing only (no timeline marker/project/transcript panel API) | **DEFERRED** (Wrong abstraction for offline speech-to-text & subtitle authoring) |
| **Native `.sesx` (v1.9) XML Interop** | Supported as file-based session interchange | **RETAINED** as fallback export alongside CEP |

---

## 2. Three-Layer Plugin Architecture (Shared Central Engine)

The Adobe Audition Plugin (`P1`) and the AVAPARDAZ Web Application (`P2`) share **one single local ASR core** (`AVAPARDAZ ASR CORE` + `LocalCompanionService`). Zero duplicate inference engines exist.

```
+-----------------------------------------------------------------------+
|  Adobe Audition Desktop Host (macOS / Windows)                        |
|  +-----------------------------------------------------------------+  |
|  |  CEP Panel (packages/audition-cep-plugin/client/)               |  |
|  |  - Strict CSP HTML5 + Vanilla JS (zero remote CDN/scripts)      |  |
|  |  - RTL Persian Transcript Editor (Search/Replace/Split/Merge)   |  |
|  |  - Export: UTF-8 TXT, SRT, VTT, JSON                            |  |
|  +------------------------+----------------------------------------+  |
|                           | CSInterface.evalScript()                  |
|  +------------------------v----------------------------------------+  |
|  |  ExtendScript Host Bridge (jsx/auditionHost.jsx)                |  |
|  |  - Read active document path / selection metadata               |  |
|  |  - Seek playhead / write Audition cue markers (where exposed)   |  |
|  +------------------------+----------------------------------------+  |
+---------------------------|-------------------------------------------+
                            | Loopback HTTP ONLY (127.0.0.1:47291)
                            | HMAC-SHA256 Signed IPC + Nonce Replay Guard
+---------------------------v-------------------------------------------+
|  AVAPARDAZ Local Companion Daemon (companion/avapardaz-companion.ts)  |
|  - LocalCompanionService (src/host-bridge/companion/)                 |
|  - LocalSherpaNeuralEngine (src/asr-core/LocalSherpaNeuralEngine.ts)  |
|  - LongAudioChunkedPipeline (O(1) sliding window + overlap dedup)     |
|  - Offline CPU Runtime: sherpa-onnx-offline (strict proxy blackhole)  |
+-----------------------------------------------------------------------+
```

---

## 3. Implemented Package Inventory (`packages/audition-cep-plugin/`)

| File | Purpose | Verification Status |
| :--- | :--- | :--- |
| `CSXS/manifest.xml` | CEP 11 extension descriptor (`Host Name="AUDT" Version="[22.0,99.9]"`) | `VERIFIED` (Automated XML & unit check) |
| `jsx/auditionHost.jsx` | ExtendScript host bridge for active document path, selection, markers, playhead | `IMPLEMENTED — UNVERIFIED IN LIVE AUDITION` |
| `client/index.html` | Persian RTL panel shell with strict CSP (`default-src 'self'`, `connect-src http://127.0.0.1:*`) | `VERIFIED` (Automated CSP check) |
| `client/styles.css` | Dark studio-aligned RTL UI styles (zero external fonts/CDNs) | `IMPLEMENTED` |
| `client/app.js` | HMAC-SHA256 handshake (`contract v2.0.0`), job polling/cancel, XSS-safe DOM (`textContent`), editing, undo/redo, `TXT`/`SRT`/`VTT`/`JSON` export | `VERIFIED` (Unit + contract alignment) |
| `installers/install-macos.sh` & `uninstall-macos.sh` | User-level CEP installation (`~/Library/Application Support/Adobe/CEP/extensions/`) + `PlayerDebugMode` toggle; preserves user models/data on uninstall | `IMPLEMENTED — UNVERIFIED ON PHYSICAL MACOS` |
| `installers/install-windows.ps1` & `uninstall-windows.ps1` | User-level CEP installation (`%APPDATA%\Adobe\CEP\extensions\`) + CSXS registry debug flag; preserves user models/data on uninstall | `IMPLEMENTED — UNVERIFIED ON PHYSICAL WINDOWS` |
| `scripts/package-plugin.mjs` | Deterministic packager generating `.tar.gz` + SHA-256 manifest in `dist-packages/` | `VERIFIED` (`avapardaz-audition-cep-v1.0.0.tar.gz`, `11,369 B`, SHA-256 `b96b5e5a...ef9a68`) |

---

## 4. Honest Platform Limitations & Verification Boundaries

1. **No Live Adobe Audition Desktop Host in Container (`BLOCKED`):** This Linux `G0_CPU_ONLY` container cannot install or run Adobe Audition (macOS/Windows). Therefore, ExtendScript calls (`jsx/auditionHost.jsx`), CEP panel rendering inside Audition, playhead sync, and cue marker insertion are classified strictly as **`IMPLEMENTED BUT NOT VERIFIED`**.
2. **Unsigned Debug Package (`BLOCKED` for Public Distribution):** Commercial distribution requires signing as a `.zxp` via Adobe `ZXPSignCmd` with a valid code-signing certificate so end users do not need `PlayerDebugMode=1`.
