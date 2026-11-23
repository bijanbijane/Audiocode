# AVAPARDAZ — CURRENT EXECUTION STATE (HISTORICAL SNAPSHOT — SUPERSEDED BY AUTHORITATIVE STATE)

> **AUTHORITATIVE POINTER (`2026-11-23`):** این سند یک تصویر تاریخی از وضعیت پروژه است. **تنها مرجع معتبر و واحد پروژه (Single Source of Truth)** سند [`docs/AVAPARDAZ/AUTHORITATIVE-PROJECT-STATE.md`](./AUTHORITATIVE-PROJECT-STATE.md) (`AVP-AUTH-STATE-0.1`) است. در هرگونه تعارض (از جمله وضعیت `PHASE-02`، مسیرهای ASR، نقاط حافظه و یافته‌های امنیتی)، `AUTHORITATIVE-PROJECT-STATE.md` ملاک قطعی است.

**Document ID:** `AVP-CURRENT-STATE-4.1`  
**Supersedes:** `AVP-CURRENT-STATE-4.0` (`2026-11-20` snapshot)  
**Authoritative Reference:** [`docs/AVAPARDAZ/AUTHORITATIVE-PROJECT-STATE.md`](./AUTHORITATIVE-PROJECT-STATE.md)  
**Last Updated:** `2026-11-23`  
**Workspace Root:** `/app/applet`  
**Current Branch:** `UNKNOWN (Not a Git working tree — .git absent)`  
**Current Commit:** `UNKNOWN (Not a Git working tree — COMMIT: NOT_AVAILABLE)`

---

## 1. Authoritative Final Acceptance Status

| Field | Value |
| :--- | :--- |
| **Roadmap Version** | `Master Roadmap v3.1` + User Directives (`PHASE-02`, `PHASE-08`..`PHASE-15`) |
| **Completed & Verified Phases** | `PHASE-00` (`ACCEPTED`), `PHASE-01` (`ACCEPTED`), `PHASE-02` (**`BLOCKED`** — superseded on `2026-11-22` by `docs/phase-02/RECOVERY-003-ACCEPTANCE-GAP.md`; dataset `3.5635 h < 6.0 h`, `0.0 h` conversational/disfluency/code-switching/TextGrid, `M2_HARDWARE = NOT_AVAILABLE`), `PHASE-08` (`VERIFIED ON LINUX CPU`), `PHASE-09`/`10`/`11` (`IMPLEMENTED` — Audition CEP package + Shared Companion + Web integration; Host GUI untested in Linux), `PHASE-12` (`PARTIAL / RE-OPENED BY PHASE-0 AUDIT` — see `AUTHORITATIVE-PROJECT-STATE.md` §12 for P0/P1 findings on `server.ts` & `LocalSherpaNeuralEngine.ts`), `PHASE-14` (`LICENSES CLEARED`; payments/signing external blockers) |
| **Phase-15 Final Verdict (Public Commercial Release)** | **`BLOCKED`** (Physical macOS/Windows + live Adobe Audition GUI test, signed `.zxp`/`.dmg`/`.msi`, `package-lock.json` CVE scan, Phase-02 dataset & alignment gap, P0 memory streaming & security hardening) |
| **Phase-15 Final Verdict (Internal Linux Technical Alpha)** | **`READY WITH RESTRICTIONS`** (See `AUTHORITATIVE-PROJECT-STATE.md` for verified memory, ASR routing, and security caveats) |
| **Roadmap State** | **SUPERSEDED BY PHASE 0 AUDIT (`AVP-AUTH-STATE-0.1`) — NEXT EXECUTION: PHASE 1 MEMORY STREAMING & SECURITY HARDENING** |

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
  - `tsc --noEmit` (`npm run lint`): **`0` errors** across the entire TypeScript workspace (`[Observed Fact]` verified `2026-11-23`; earlier `2026-11-20` note about 8 stale Phase-00 `.test.ts` files is resolved).
  - Binary & Secret Hygiene (`[Observed Fact]` reconciled `2026-11-23`): `models/persian-zipformer-transducer/1.0.0/` contains on-disk INT8 Zipformer ONNX assets (`115,757,880 B` mandatory: `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt`) plus `sample.wav` (`775,738 B`) acquired in `AVP-PERSIAN-ZIPFORMER-ASSET-ACQUISITION-001`; prior `2026-11-20` note stating "`0` `.onnx`/`.wav` files in repo" is superseded.

---

## 3. External Blockers Preventing Public Commercial Release

1. Physical macOS (Apple Silicon) + Windows (`x64`) + live Adobe Audition 24/25 GUI installation, ExtendScript marker & playback verification.
2. Signed standalone OS Companion installers (Apple Developer ID notarized `.dmg` / Windows Authenticode `.msi`) + signed Adobe `.zxp` (`ZXPSignCmd`).
3. Canonical `package-lock.json` + dependency CVE remediation (`npm audit` returned `ENOLOCK` due to `bun.lock` only) & cleanup of `8` legacy stale Phase-00 `.test.ts` files.
4. GPU-backed bilingual Persian+English code-switching fine-tuning (`PHASE-06`) & real-world noisy/accented external beta evaluation.
5. Live payment gateway (ZarinPal / Stripe) & dedicated Iran+Global SHA-256 model CDN mirrors.

---

## 4. Post-ADR-026 Autonomous P0 Engineering Continuation (`2026-11-21` — `VERIFIED WITH BLOCKERS`)

*(Note: Prior `PHASE-15` roadmap termination under `ADR-026` remains preserved; the following P0 engineering missions were executed under explicit subsequent user directives.)*

- **Missions Completed & Verified (`30 / 30` automated tests PASS across 8 suites):**
  - `AVP-P0-001` (Unified Local ASR Runtime: Browser Web Worker + `onnxruntime-web@1.31.1` WASM/OPFS independent of Companion; Native Companion independent of Browser; zero cloud fallback).
  - `AVP-P0-002` (Manifest Schema v2.0.0, checksum-vs-signature separation, 19-state lifecycle machine, transactional chunked delivery, real unmocked offline ORT WASM 11-step qualification pipeline).
  - `AVP-P0-003` (End-to-end integer-sample project workflow: Import → Transcribe → Analyze → 7-state Decisions → Immutable-source Apply → Undo/Redo → Atomic Persist/Recover → Verified WAV Export + Source-Change Invalidation).
  - `AVP-P0-004` (12-state Companion lifecycle, single-instance stale-PID lock, hardened HMAC/TTL/`request_id` IPC, sequenced chunked PCM transfer, `JOB_LIST`/`JOB_RECONNECT`, Audition CEP `sourceIdentity` & `SOURCE_CHANGED` guard).
  - `AVP-P0-005` (Cross-runtime conformance tests, CI workflow `.github/workflows/avapardaz-quality-gates.yml`, machine-readable `release-acceptance-manifest.json`).
  - `AVP-P0-006` (13 trust boundaries in `security-acceptance-register.json`, prototype-pollution/depth project validator, audio decoder resource bounds, symlink-aware path confinement, privacy-preserving log sanitizer).
  - `AVP-P0-007` (Component version compatibility, Browser/Native first-run readiness, 17-state atomic update + rollback orchestrator, safe uninstall preserving user projects/media, prod deployment validator).
  - `AVP-P0-008` (Kaiser-windowed sinc up/down resampling with >40 dB stopband attenuation, explicit multichannel downmix, fades, silence vs ambient, NaN/Inf rejection, bit-identical PCM16/PCM24/Float32 WAV decode-back verification).
  - `AVP-P0-009` (5-layer Persian linguistic quality engine, script-aware Unicode/ZWNJ normalization, `VERBATIM` colloquial preservation, non-destructive punctuation, alignment fidelity).
  - `AVP-P0-010` (6-tier acoustic-priority evidence hierarchy, 25-category Persian error taxonomy, meaning-critical token protection, 19/19 adversarial regression cases with `0` false auto-corrections, revision-safe HITL ledger).
  - `AVP-PERSIAN-ZIPFORMER-ASSET-ACQUISITION-001` (Genuine `ramin-mahmoodi/persian-zipformer-asr` commit `0408facbcf3f670121def48e0802c395c225d150` INT8 Transducer assets acquired to `models/persian-zipformer-transducer/1.0.0/`, `115,757,880` B mandatory package SHA-256 & ONNX structure verified via `node scripts/acquire-persian-zipformer.mjs --verify-only`; strictly NOT wired to CTC engine).
  - `AVP-P0-012` (Versioned O(1)-indexed domain vocabulary benchmarked at 10k entries, machine-guess quarantine, proper-noun/acronym protection, compound analysis routed strictly through `AVP-P0-010`).
- **Open Blockers (`release-acceptance-manifest.json`):** `BLK-001` (detached publisher signing keys), `BLK-002` (upstream Zipformer commit omitted standalone `LICENSE` file; Apache-2.0 declared in `README.md`), `BLK-003` (human-verified multi-domain Persian audio benchmark corpus), `BLK-004` (physical macOS/Windows/Adobe Audition host & native `sherpa-onnx` binary), `BLK-005` (`package-lock.json` for `npm audit`).

