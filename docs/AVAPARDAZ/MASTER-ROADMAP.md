# AVAPARDAZ — MASTER ROADMAP (v3.1)

**Document ID:** `AVP-MASTER-ROADMAP-3.1`  
**Supersedes:** `AVP-MASTER-ROADMAP-3.0` (per `AVP-ADR-PHASE-ORDER-001` — formally placing Local Runtime Foundation & Memory-Safe Audio Pipeline at `PHASE-01` prior to Model Discovery & Multi-Device CPU Benchmark at `PHASE-02`).  
**Effective Date:** `2026-11-20`  
**Status:** ACTIVE (`PHASE-00` Accepted, `PHASE-01` Accepted; Exact Next Authorized Phase: `PHASE-02` / `AVP-P02-001`)  
**Authority:** Master Engineering Directive v3.1 — One Central ASR Engine / Two Independent Products / Multi-Device Adaptive Local CPU Execution

---

## 1. Non-Negotiable Core Mandate

Build one central speech recognition engine — **`AVAPARDAZ ASR CORE`** — serving two independent products across diverse user devices:

- **Priority `P0` — Central ASR Engine (`AVAPARDAZ ASR CORE`):** Platform-independent contracts, bounded memory-safe audio pipeline, adaptive hardware/model selection, shared Persian/English linguistic processing, model lifecycle, and error/resource governance.
- **Priority `P1` — Product A: Adobe Audition Plugin (Primary Commercial Product):** Integrated Adobe Audition CEP Panel (`HTML5/TS` + `ExtendScript`) backed by a standalone Local Companion running Native CPU inference over loopback HMAC IPC. Works independently without the Web App open.
- **Priority `P2` — Product B: Web Application Client (Second Product):** React/TypeScript Studio UI consuming the exact same engine contracts and model catalog, running locally in a Browser Web Worker via `onnxruntime-web` (WASM CPU / SIMD) + OPFS offline storage — with **zero dependency on Native Companion**.

### Absolute Production Invariants
1. `NO MANDATORY CLOUD ASR` / `NO MANDATORY THIRD-PARTY ASR API` / `NO REMOTE MODEL INFERENCE`
2. `NO USER AUDIO UPLOAD FOR ASR` (Zero silent cloud fallback; `HTTP 410 Gone` enforced on legacy cloud ASR route)
3. `NO REQUIRED GPU` — `CPU-FIRST EXECUTION` across Windows, macOS, Linux (Web), `x86_64` and `ARM64`
4. `LOCAL MODEL WEIGHTS` + `OFFLINE INFERENCE` after installation & SHA-256 verification
5. `ADAPTIVE MODEL & RUNTIME SELECTION` across 4 hardware tiers (`TIER-0`..`TIER-3`) and 3 profiles (`AVP_MODEL_LITE`, `AVP_MODEL_BALANCED`, `AVP_MODEL_QUALITY`) — never hardcoded to a single reference machine (e.g. Apple M2)

---

## 2. Authoritative Persistent Engineering Memory (`docs/AVAPARDAZ/`)

- **`MASTER-ROADMAP.md`** — Authoritative 10-phase roadmap (`v3.1`, this file)
- **`CURRENT-STATE.md`** — Authoritative live execution state & next-phase pointer
- **`IMPLEMENTATION-LEDGER.md`** — Authoritative task ledger (`AVP-P00-*`..`AVP-P09-*`)
- **`DECISION-LOG.md`** — Authoritative decision register (`ADR-001`..`ADR-022`, `AVP-ADR-PHASE-ORDER-001`)
- **`ARCHITECTURE-DECISIONS.md`** — Formal ADRs & weighted scoring matrix
- **`PHASE-00-BASELINE-AUDIT.md`** & **`PHASE-01-ACCEPTANCE-REPORT.md`** — Evidence-backed phase audits & acceptance gate records
- **`MEMORY-BUDGET-IMPLEMENTATION.md`**, **`STREAMING-INGEST-IMPLEMENTATION.md`**, **`STORAGE-IMPLEMENTATION-REPORT.md`**, **`LOCAL-ONLY-VERIFICATION.md`**, **`LONG-FILE-STRESS-REPORT.md`** — Phase-01 runtime & stress deliverables
- **`ENGINE-INTERFACE-SPEC.md`**, **`MODEL-REGISTRY.md`**, **`MODEL-PROVENANCE.md`**, **`PRODUCT-INTEGRATION-STATUS.md`**, **`HARDWARE-COMPATIBILITY-MATRIX.md`**, **`HANDOFF-LOG.md`**

---

## 3. Formal 10-Phase Master Roadmap (`MASTER v3.1`)

| Phase ID | Mission ID | Phase Name | Primary Objectives | Mandatory Exit Gate | Status |
| :--- | :---: | :--- | :--- | :--- | :---: |
| **`PHASE-00`** | `AVP-P00-001` | **Reality Audit & Architecture Freeze** | Verify repo truth, real ASR path, model weights, cloud isolation, Adobe/Web feasibility, multi-device matrix, adaptive architecture, weighted Core decision, test baseline, and permanent memory. | 10/10 Acceptance Gates | `ACCEPTED` |
| **`PHASE-01`** | `AVP-P01-001` | **Local Runtime Foundation & Memory-Safe Audio Pipeline** | Harden `MemoryBudgetManager` (`1,024 MiB` ceiling, leak detection), OPFS + bounded `32 MiB` fallback & pool quota, chunked Kaiser-Sinc resampling, block-backed windowed playback & streaming WAV export, zero Cloud ASR (`410 Gone`) & zero fake transcripts, cross-platform `TIER-0..3` capability policy, and 30/60/120-min stress verification. | 8/8 Acceptance Gates + Stress Report | `ACCEPTED` |
| **`PHASE-02`** | `AVP-P02-001` | **Open-Source Model Discovery & Multi-Device CPU Benchmark** | Audited licenses/provenance, acquired `25` real `CC-BY-4.0` FLEURS `dev` WAVs (`277.33s`), ran reproducible offline CPU bake-off on `5` ONNX models (`results-2026-11-20.json`) with 2,000-resample 95% CIs, selected `Shenava-Rizeh` (`AVP_MODEL_LITE`) & `Whisper large-v3-turbo INT8` (`AVP_MODEL_QUALITY`). | `7/7` Gates (`PHASE-02-ACCEPTANCE-REPORT.md`) | **`ACCEPTED`** |
| **`PHASE-03 / 08`** | `AVP-P08-001` | **Central ASR Core, Native CPU Runtime & Long-Audio Engine** | Built `LocalSherpaNeuralEngine.ts`, `LongAudioChunkedPipeline.ts` (`O(1)` up to `60m`), `subtitleExporter.ts`, `LocalCompanionService.ts` (`v2.0.0` HMAC IPC), and standalone `companion/avapardaz-companion.ts`; proved `whisper-base-int8` `+15.0 pp` Persian regression (`ADR-024`). | Live offline Companion + `7/7` tests PASS (`PHASE-08-BENCHMARKS.md`) | **`VERIFIED (LINUX CPU)`** *(Physical macOS/Win `BLOCKED`)* |
| **`PHASE-04 / 09`** | `AVP-P09-001` | **Adobe Audition Plugin Engineering (`P1`)** | Verified CEP (`AUDT`) architecture (UXP unsupported in Audition); built `packages/audition-cep-plugin/` (`manifest.xml`, `auditionHost.jsx`, strict-CSP RTL editor, macOS/Windows installers) & deterministic package `avapardaz-audition-cep-v1.0.0.tar.gz`. | Package SHA-256 verified (`PHASE-09-TEST-REPORT.md`) | **`IMPLEMENTED`** *(Live Audition GUI `BLOCKED`)* |
| **`PHASE-05 / 10`** | `AVP-P10-001` | **Web Application Shared Local ASR Integration (`P2`)** | Mounted `/api/v2/companion` in `server.ts`, wired `CompanionWebClient.ts` into `src/App.tsx` (`handleRunPersianAsr`) with fail-closed local-only behavior (`LOCAL_ASR_MODEL_NOT_INSTALLED`). Standalone browser-only WASM worker remains next enhancement. | `vite build` PASS + Live Companion verified | **`IMPLEMENTED (SHARED COMPANION)`** |
| **`PHASE-06 / 07`** | `AVP-P06-001` | **GPU Model Specialization & Advanced Speech Intelligence** | Requires dedicated GPU cluster + `>= 50–200h` consented Persian/English code-switching corpus to solve Whisper language-lock (`CS_CER 63.90%`). | Frozen test set `p < 0.05` beat | **`BLOCKED (NO GPU / CORPUS)`** |
| **`PHASE-11..14`** | `AVP-P12/14` | **Lifecycle, Red-Team Security, Beta & Commercial Readiness** | Red-Team `7/7` PASS (`PHASE-12-SECURITY-DECISION.md`); commercial model licenses (`Apache-2.0`/`MIT`) cleared & Ed25519 offline licensing verified (`PHASE-14-COMMERCIAL-READINESS.md`). Blocked on `package-lock.json` CVE scan, code signing, beta cohort, payment gateway. | Security & Commercial Audits | **`PARTIAL / EXTERNAL BLOCKERS`** |
| **`PHASE-15`** | `AVP-P15-001` | **Final Product Acceptance & Controlled Release Decision** | Issued authoritative 10-gate independent acceptance verdict (`PHASE-15-FINAL-ACCEPTANCE-DECISION.md`): **`BLOCKED`** for Public Commercial Release / **`READY WITH RESTRICTIONS`** for Internal Linux Technical Alpha. | Final Signed Verdict (`ADR-026`) | **`CLOSED — ROADMAP TERMINATED`** |

---

## 4. Roadmap Closure Governance

Per `PHASE-15` (`ADR-026`), the original AVAPARDAZ roadmap execution stops cleanly here. Next engineering cycles must begin only after provisioning the 5 external prerequisites documented in `PHASE-15-FINAL-ACCEPTANCE-DECISION.md` (physical macOS/Windows + Adobe Audition host, code-signing certificates, lockfile CVE audit, GPU bilingual corpus/training, and live payment/CDN infrastructure).

