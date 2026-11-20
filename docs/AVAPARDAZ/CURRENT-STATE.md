# AVAPARDAZ — CURRENT EXECUTION STATE (AUTHORITATIVE — FINAL ROADMAP CLOSE)

**Document ID:** `AVP-CURRENT-STATE-4.0`  
**Supersedes:** `AVP-CURRENT-STATE-3.1` (`PHASE-01` snapshot)  
**Last Updated:** `2026-11-20T14:57:00Z`  
**Workspace Root:** `/app/applet`  
**Current Branch:** `NONE (Not a Git working tree — .git absent)`  
**Current Commit:** `NONE (Not a Git working tree — COMMIT: NOT_AVAILABLE)`

---

## 1. Authoritative Final Acceptance Status

| Field | Value |
| :--- | :--- |
| **Roadmap Version** | `Master Roadmap v3.1` + User Directives (`PHASE-02`, `PHASE-08`..`PHASE-15`) |
| **Completed & Verified Phases** | `PHASE-00` (`ACCEPTED`), `PHASE-01` (`ACCEPTED`), `PHASE-02` (`ACCEPTED` — `7/7` Gates, `25/25` real audio CPU benchmark), `PHASE-08` (`VERIFIED ON LINUX CPU`), `PHASE-09`/`10`/`11` (`IMPLEMENTED` — Audition CEP package + Shared Companion + Web integration; Host GUI untested in Linux), `PHASE-12` (`VERIFIED` Red-Team `7/7` PASS; `npm audit` `ENOLOCK` blocker), `PHASE-14` (`LICENSES CLEARED`; payments/signing external blockers) |
| **Phase-15 Final Verdict (Public Commercial Release)** | **`BLOCKED`** (Physical macOS/Windows + live Adobe Audition GUI test, signed `.zxp`/`.dmg`/`.msi`, `package-lock.json` CVE scan, GPU bilingual code-switching fine-tuning, live payment gateway + model CDN) |
| **Phase-15 Final Verdict (Internal Linux Technical Alpha)** | **`READY WITH RESTRICTIONS`** (Real offline CPU Persian/English ASR + hardened Shared Companion IPC + `O(1)` 60m pipeline + Web build verified live) |
| **Roadmap State** | **TERMINATED CLEANLY AT `PHASE-15` ACCEPTANCE GATE (`ADR-026`)** |

---

## 2. Verified Technical Reality Snapshot (`[OBSERVED]` / `[TESTED]` — 2026-11-20)

- **5-Model Real CPU ASR Benchmark (`25 / 25` real `CC-BY-4.0` Google FLEURS `dev` WAVs, `277.33s` total, `rc=0`, strict offline proxy-blackhole):**
  - **`Reza2kn/Shenava-Rizeh v1.0`** (`Apache-2.0`, `36.43 MiB`, INT8): **FA Norm CER `5.71%`** (`Raw 7.58%`), **`RTF 0.0360`** (`27.8×` RT), `Cold 2,128 ms`, `RSS 165.81 MiB`, native `WORD` timestamps. Selected for **`AVP_MODEL_LITE`** (Persian Fast).
  - **`openai/whisper-large-v3-turbo-int8`** (`MIT`, `988.59 MiB`): **FA Norm CER `7.71%`** (`Raw 8.71%`), **EN Norm WER `5.83%`**, **`RTF 0.6121`** (`1.63×` RT), `Cold 7,519 ms`, `RSS 1,382.88 MiB`. Selected for **`AVP_MODEL_QUALITY`** (EN / Multilingual).
  - **`openai/whisper-base-fp32`** (`MIT`, `278.90 MiB`): FA CER `29.57%`, EN WER `12.56%`, `RTF 0.2372`, `RSS 526.31 MiB`.
  - **`openai/whisper-base-int8`** (`MIT`, `153.17 MiB`): FA CER **`44.57%`** (**`+15.00 pp` statistically significant Persian regression, `95% CI [+0.74, +34.22]`!**) — **REJECTED (`ADR-024`)**.
  - **`Qwen/Qwen3-ASR-0.6B-int8`** (`Apache-2.0`, `941.28 MiB`): FA CER **`56.57%`** (transliterates Persian to Turkish/Latin script), `RTF 0.997`, `RSS 1,588 MiB` — **REJECTED ZERO-SHOT**.
- **Shared Central Local Engine & Companion (`v2.0.0` HMAC IPC):**
  - `src/asr-core/LocalSherpaNeuralEngine.ts` + `src/asr-core/LongAudioChunkedPipeline.ts` + `src/utils/subtitleExporter.ts` + `src/host-bridge/companion/LocalCompanionService.ts` + `companion/avapardaz-companion.ts`.
  - Mounted at `/api/v2/companion` in `server.ts` and consumed identically by Web App (`CompanionWebClient.ts` + `App.tsx`) and Adobe Audition CEP Plugin (`packages/audition-cep-plugin/`).
- **Installable Adobe Audition CEP Bundle:**
  - Verified CEP (`AUDT [22.0,99.9]`) is the ONLY supported panel architecture in Adobe Audition (UXP unsupported).
  - Packaged cleanly to `dist-packages/avapardaz-audition-cep-v1.0.0.tar.gz` (`11,369 B`, `9` files, SHA-256 `b96b5e5a...ef9a68`).
- **Verification Suites (`[TESTED]`):**
  - `npx tsx --test src/host-bridge/companion/__tests__/LocalCompanionAndSecurity.test.ts`: **`7 / 7` PASS** (`4.87s` — includes live offline Persian neural transcription over HTTP HMAC IPC, `10s..60m` `O(1)` memory stress, `AbortSignal`, DNS rebinding/Origin CSRF/nonce replay/path traversal/corrupt WAV Red-Team tests, and CEP manifest/CSP verification).
  - `python3 -m unittest benchmarks/phase02/test_evaluation_metrics.py -v`: **`6 / 6` PASS** (`0.013s`).
  - `npm run build` (`vite build`): **`PASS`**.
  - `tsc --noEmit`: **`0` errors** in all Phase-01..15 production & test files (only pre-existing 8 stale Phase-00 legacy `.test.ts` files fail).
  - Binary & Secret Hygiene: **`0`** `.onnx`/`.wav` files in repo; **`0`** hardcoded secrets.

---

## 3. External Blockers Preventing Public Commercial Release

1. Physical macOS (Apple Silicon) + Windows (`x64`) + live Adobe Audition 24/25 GUI installation, ExtendScript marker & playback verification.
2. Signed standalone OS Companion installers (Apple Developer ID notarized `.dmg` / Windows Authenticode `.msi`) + signed Adobe `.zxp` (`ZXPSignCmd`).
3. Canonical `package-lock.json` + dependency CVE remediation (`npm audit` returned `ENOLOCK` due to `bun.lock` only) & cleanup of `8` legacy stale Phase-00 `.test.ts` files.
4. GPU-backed bilingual Persian+English code-switching fine-tuning (`PHASE-06`) & real-world noisy/accented external beta evaluation.
5. Live payment gateway (ZarinPal / Stripe) & dedicated Iran+Global SHA-256 model CDN mirrors.
