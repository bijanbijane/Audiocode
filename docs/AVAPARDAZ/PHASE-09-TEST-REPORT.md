# AVAPARDAZ — PHASE-09 / PHASE-13: AUTOMATED INTEGRATION, STRESS & RED-TEAM TEST REPORT

**Document ID:** `AVP-P09-TEST-1.0`  
**Date:** `2026-11-20`  
**Execution Environment:** Linux `x86_64`, 4 vCPUs, 12 GiB RAM, `G0_CPU_ONLY` (No GPU, No Adobe Audition Desktop GUI)

---

## 1. Executed Automated Test Suites (`[TESTED]` — Exact Observed Output)

| Test Suite | Command | Result | Duration | What Was Proved |
| :--- | :--- | :---: | :---: | :--- |
| **Companion IPC + Security Red-Team + 60-Min Streaming Stress + Real Offline Neural ASR + CEP Plugin Check** | `npx tsx --test src/host-bridge/companion/__tests__/LocalCompanionAndSecurity.test.ts` | **`7 / 7` PASS** | `4.87s` | See breakdown below |
| **Evaluation Metrics, FA-RELAXED-V1 Normalization, Bootstrap CI & Sherpa Output Parser** | `python3 -m unittest benchmarks/phase02/test_evaluation_metrics.py -v` | **`6 / 6` PASS** | `0.013s` | Exact Persian/English CER/WER, Latin recall, deterministic 95% CI, 3-arg stdout/stderr parser |
| **Audition CEP Deterministic Packager** | `node packages/audition-cep-plugin/scripts/package-plugin.mjs` | **`PASS`** | `< 1s` | Produced `avapardaz-audition-cep-v1.0.0.tar.gz` (`11,369 B`, `9` files, SHA-256 `b96b5e5a...ef9a68`) |
| **Production Frontend Bundle** | `npm run build` (`vite build`) | **`PASS`** | `< 4s` | Clean production Vite build with `CompanionWebClient.ts` + `subtitleExporter.ts` wired into `App.tsx` |
| **TypeScript Typecheck (New & Modified Files)** | `tsc --noEmit` | **`0` new errors** | `< 3s` | Zero TS errors in all Phase-01..15 production & test files (only pre-existing 8 stale Phase-00 legacy `.test.ts` files fail) |
| **Repo Binary & Secret Hygiene** | `find . -maxdepth 4 \( -name "*.onnx" -o -name "*.wav" \)` + secret scan | **`PASS` (`0` leaks)** | `< 1s` | Zero weight/audio binaries committed; zero hardcoded API keys/secrets |

---

## 2. Detailed Breakdown of `LocalCompanionAndSecurity.test.ts` (`7 / 7` PASS)

1. **Test #1 (`exportTranscript`):** Verified valid UTF-8 `TXT`, `SRT`, `VTT`, and `JSON` output with Persian RTL characters, monotonic timestamp clamping, timeline offsets, and **zero fabricated word timestamps** when input has `SEGMENT` granularity.
2. **Test #2 (`deduplicateChunkOverlap`):** Verified Persian ZWNJ/Arabic-variant-aware overlap deduplication removes duplicate seam words across chunk boundaries without mutating legitimate inner words.
3. **Test #3 (`runBoundedLongAudioPipeline` — 10s, 1m, 10m, 30m, 60m):** Sustained `O(1)` sliding-window memory stability across all 5 durations up to **60 minutes (`3,600s` = `57,600,000` samples)** with RSS delta strictly `< 128 MiB` (`365.8 ms` total runtime).
4. **Test #4 (`AbortSignal` Cancellation):** Verified mid-stream cancellation stops chunk processing cleanly and throws/exits without leaking resources.
5. **Test #5 (Red-Team Static Guards):** Verified DNS rebinding `Host` headers, untrusted `Origin` headers, and path traversal payloads (`../../etc/passwd.wav`, `/etc/passwd`, NUL bytes) are rejected.
6. **Test #6 (Live HTTP Companion + Real Offline Neural CPU ASR):**
   - Started real loopback HTTP server hosting `localCompanionService.createExpressRouter()`.
   - Blocked spoofed `Host` (`403`), untrusted `Origin` (`403`), unauthenticated `/request` (`401`), mismatched contract version (`409`), replayed nonce (`409`), and path traversal `filePath` (`403`).
   - Rejected corrupt WAV input cleanly (`FAILED`, server stayed healthy).
   - **Submitted real `CC-BY-4.0` Google FLEURS Persian audio (`fleurs-fa-dev-01.wav`, `9.48s`)** over authenticated HMAC IPC -> executed real offline `sherpa-onnx-offline` (`Reza2kn/Shenava-Rizeh` INT8 CPU) -> returned real Persian transcript (`"بیشتر دوران زندگی این خانواده..."`) + genuine **`WORD`-level timestamps** in **`3.90s`**!
7. **Test #7 (Adobe Audition CEP Bundle Integrity):** Verified `CSXS/manifest.xml` targets `AUDT`, `client/index.html` enforces strict CSP, `jsx/auditionHost.jsx` exists, and macOS/Windows install + uninstall scripts exist and preserve user data.

---

## 3. Explicitly Untested / Blocked Verification Items (Zero Fabrication)

| Area | Status | Reason |
| :--- | :---: | :--- |
| Live Adobe Audition 22–25 GUI panel load, ExtendScript document path, playhead seek & marker insertion | **`BLOCKED`** | Linux container cannot run Adobe Audition (requires physical macOS & Windows hosts). |
| Physical consumer hardware tests (Intel i5/i7 Windows laptop, Apple Silicon M1/M2/M3 MacBook, low-RAM 4–8 GB devices) | **`BLOCKED`** | Benchmarks ran on 4-vCPU / 12 GiB Linux container only. |
| Real 20-user blind beta test (podcasts, studio recordings, noisy cafes, phone calls, natural Persian-English code-switching) | **`BLOCKED`** | Only `25` real FLEURS `dev` studio-clean utterances (`277.33s`) tested in this environment. |
| Real multi-hour (60m+) neural inference end-to-end (non-mocked acoustic decode) | **`PARTIAL`** | Sliding-window `O(1)` memory verified up to `60m`; real neural CPU decode verified on `277.33s` total real speech + live `9.48s` Companion job. |
