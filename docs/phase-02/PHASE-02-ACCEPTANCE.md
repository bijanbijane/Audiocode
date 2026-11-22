# AVAPARDAZ — PHASE-02: ACCEPTANCE RECONCILIATION & GATE DECISION

**Document ID:** `AVP-P02-ACCEPTANCE-2.0`  
**Execution ID:** `AVP-P02-RECOVERY-002`  
**Target Phase:** `PHASE-02` (Base ASR Model Discovery, Offline CPU Benchmarking & Evidence-Based Selection)  
**Reconciliation Date:** `2026-11-22`  
**Final Phase-02 Gate Status:** **`BLOCKED`**  
**Next Authorized Phase:** **`NONE`** (PHASE-03, PHASE-04, PHASE-05, and PHASE-06 remain **PROHIBITED** until all mandatory blockers in Section 6 are cleared)  
**Production Code Modifications:** **`NONE`**  
**Model Training / Fine-Tuning:** **`NOT_STARTED`**  
**Git Metadata:** `GIT_AVAILABILITY = NOT_AVAILABLE` (`no .git directory in /app/applet`)

---

## 1. Authoritative 11-Document Inventory & Discrepancy Reconciliation

### 1.1 Discrepancy Resolution ("4 Missing" Claim vs. Actual Filesystem Inventory)

Prior execution notes (`AVP-P02-RECOVERY-001`) reported `MISSING_PHASE_02_DOCUMENTS = 4`, referring solely to the 4 summary documents (`MODEL-SELECTION-REPORT.md`, `CPU-BENCHMARK-RESULTS.md`, `LICENSE-COMPLIANCE-REGISTER.md`, `PHASE-02-ACCEPTANCE.md`).  
Direct filesystem inspection of `docs/phase-02/` at the start of `AVP-P02-RECOVERY-002` against the authoritative **11-document PHASE-02 Revision 2 inventory** revealed:
- **Pre-Recovery Present:** **`2`** documents (`MODEL-DISCOVERY.md`, `BENCHMARK-PROTOCOL.md`).
- **Pre-Recovery Genuinely Missing:** **`9`** documents (all 9 created during `AVP-P02-RECOVERY-002`).
- **Post-Recovery Present:** **`11 / 11`** documents (`0` missing; `0` pre-existing documents modified or overwritten).

### 1.2 Complete `docs/phase-02/` Document Inventory

| # | Mandatory Phase-02 Document | Pre-Recovery State | Action Taken in `AVP-P02-RECOVERY-002` | Post-Recovery State | Pre-Existing SHA-256 Preserved? |
| :-: | :--- | :---: | :--- | :---: | :---: |
| 1 | `docs/phase-02/MODEL-DISCOVERY.md` | **PRESENT** | Preserved untouched (`16,395 B`) | **PRESENT** | `YES` (`5c52407173452884da40e1e6fa0d0b102d11cf4b5fe826b59324aa64e5eb40d0`) |
| 2 | `docs/phase-02/MODEL-CANDIDATE-MATRIX.md` | **MISSING** | **CREATED** (`AVP-P02-MATRIX-2.0`) | **PRESENT** | N/A (new) |
| 3 | `docs/phase-02/LICENSE-COMPLIANCE-REGISTER.md` | **MISSING** | **CREATED** (`AVP-P02-LICENSE-2.0`) | **PRESENT** | N/A (new) |
| 4 | `docs/phase-02/DATASET-REGISTER.md` | **MISSING** | **CREATED** (`AVP-P02-DATASET-REG-2.0`) | **PRESENT** | N/A (new) |
| 5 | `docs/phase-02/DATASET-ANNOTATION-STANDARD.md` | **MISSING** | **CREATED** (`AVP-P02-ANNOT-STD-2.0`) | **PRESENT** | N/A (new) |
| 6 | `docs/phase-02/BENCHMARK-PROTOCOL.md` | **PRESENT** | Preserved untouched (`6,661 B`) | **PRESENT** | `YES` (`4b3f76ce3eedc287806e9a75abfc987c402495c146b6a548d90b4896b8a3a945`) |
| 7 | `docs/phase-02/CPU-BENCHMARK-RESULTS.md` | **MISSING** | **CREATED** (`AVP-P02-CPU-BENCH-2.0`) | **PRESENT** | N/A (new) |
| 8 | `docs/phase-02/TIMESTAMP-EVALUATION.md` | **MISSING** | **CREATED** (`AVP-P02-TS-2.0`) | **PRESENT** | N/A (new) |
| 9 | `docs/phase-02/OFFLINE-AND-STABILITY-REPORT.md` | **MISSING** | **CREATED** (`AVP-P02-OFFLINE-2.0`) | **PRESENT** | N/A (new) |
| 10 | `docs/phase-02/MODEL-SELECTION-REPORT.md` | **MISSING** | **CREATED** (`AVP-P02-SELECTION-2.0`) | **PRESENT** | N/A (new) |
| 11 | `docs/phase-02/PHASE-02-ACCEPTANCE.md` | **MISSING** | **CREATED** (`AVP-P02-ACCEPTANCE-2.0`, this document) | **PRESENT** | N/A (new) |

> **Historical Artifacts Preserved Untouched:** All 5 legacy files under `docs/AVAPARDAZ/` (`PHASE-02-ACCEPTANCE-REPORT.md`, `PHASE-02-LICENSE-AUDIT.md`, `MODEL-SELECTION-REPORT.md`, `MODEL-PROVENANCE.md`, `PHASE-02-RUNTIME-COMPATIBILITY.md`) and all raw benchmark files under `benchmarks/phase02/` remain intact and unmodified. No `docs/phase-03/`..`docs/phase-06/` directories exist.

---

## 2. Raw Evidence Ledger (Independently Verified SHA-256 Digests)

| Evidence ID | File Path | Bytes | `SHA-256` Digest | Date / Hardware | Audit Verdict | Notes |
| :---: | :--- | ---: | :--- | :--- | :---: | :--- |
| **`EVID-01`** | `benchmarks/phase02/results-2026-11-20.json` | `90,250` | `7abb940d90ae3df4176a66dac9280f105c3b7917541019f823e451ca7b866fe9` | `2026-11-20T14:35:29Z` / Linux `x86_64` `4 vCPU` `12 GiB` | **`VERIFIED` (with caveat)** | Real 5-model offline CPU bake-off on 25 FLEURS `dev` WAVs (`277.33s`). Caveat: `whisper-large-v3-turbo-int8` raw JSON has `"offline_verified": false` and `subsets.en.total_inference_sec = 0.0`. |
| **`EVID-02`** | `benchmarks/phase02/product-fit-results-2026-11-22.json` | `4,680` | `f75ff6a32f654c1cd8ed1eb4ce5274926dde6f7ab7bb51a42d40c9753a03648d` | `2026-11-22T16:14:50Z` / Linux `x86_64` `4 vCPU` `12 GiB` | **`VERIFIED`** | Thread scaling (`1/2/4T`), offset probe (`0.0`/`3.8 ms`), verbatim repetition (`14/14`), silence hallucination (`0` words), SNR/tempo drift, `5-min` chunked (`12×25s`, `5.96 MiB` RSS drift), `10×` sequential stability on `Shenava-Rizeh`. |
| **`EVID-03`** | `benchmarks/phase02/recovery-verification-2026-11-22.json` | `6,842` | `e8ebdb07764fb55c88d47d796bbdc7f4a1a9f26ed79263f7b8d6e6c7aae82b44` | `2026-11-22T16:25:06Z` / Linux `x86_64` `4 vCPU` `12 GiB` | **`VERIFIED` (with regex note)** | Independent `1` warmup + `5` cold offline runs (`4T`) on `Shenava-Rizeh` (`wav_0` & `wav_1`). Note: raw `rtf` field captured numerator `0.455` (`decode_sec`) instead of quotient `0.455/14.466 = 0.0315`; raw file preserved untouched. |
| **`EVID-04`** | `benchmarks/phase02/prepare_fleurs_dev_eval.py` | `8,582` | `7180028070f8183ebee613cb5185d686d0d176686e5e14bd8bfc78b79776354e` | `2026-11-20` | **`VERIFIED`** | Reproducible FLEURS `dev` downloader & normalizer (`test` split untouched). |
| **`EVID-05`** | `benchmarks/phase02/run_cpu_bakeoff.py` | `12,405` | `977584c2a1f193e855076b57bbf8ccb04c12993170db2a25cf11ef4dddf8d211` | `2026-11-20` | **`VERIFIED`** | Offline proxy-blackhole harness + paired bootstrap (`2,000` resamples, `seed=42`). |
| **`EVID-06`** | `benchmarks/phase02/run_product_fit_benchmark.py` | `20,645` | `f3c61d61fe831b6647f7af68b939a5f1957b6b61d586adb7eac0d28efbb38d54` | `2026-11-22` | **`VERIFIED`** | Product-fit test suite generating `EVID-02`. |
| **`EVID-07`** | `benchmarks/phase02/test_evaluation_metrics.py` | `3,888` | `6176e2f4fb9c5b159dbe2bf816e4bc9ff08a3de8b189cabe8f848e9f5ecc68ce` | Executed `2026-11-22` | **`VERIFIED`** | **`6/6` unit tests PASS** (`python3 -m unittest`, `0.014s`) covering Persian normalization, CER/WER, and Latin recall. |
| **`EVID-08`** | `/root/.avapardaz/models/sherpa-onnx-nemo-ctc-fa-shenava-rizeh-v1.0-non-streaming-int8-2026-06-26/model.int8.onnx` | `38,183,269` | `6bdd4ab80626ddfe0b19338a5c96fcc4f2021ad78899cece20a805a48dc5250d` | Verified on disk `2026-11-22` | **`VERIFIED`** | Installed local checkpoint matches `EVID-01`/`EVID-02` SHA-256 bit-for-bit (`tokens.txt`: `8e192963...`). |
| **`UNVER-01`** | `training/data/{train,validation,final_test}_manifest.jsonl` | `4` JSONL rows | Synthetic placeholder IDs | Audited `2026-11-22` | **`UNVERIFIED`** | **NOT REAL DATA:** 4 placeholder rows with fake 16-char hashes and **`0` audio files on disk**. Excluded from all claims. |
| **`M2-H1`** | Physical Apple Silicon M2 (`8 GB` unified memory) benchmark | N/A | N/A | **`NOT_RUN`** | **`NOT_RUN`** | **`UNTESTED — PHYSICAL HARDWARE VALIDATION REQUIRED`**. |

---

## 3. Complete 20-Criterion Phase-02 Acceptance Matrix (`P02-01` .. `P02-20`)

**Summary Tally:** **`9 PASS`** | **`9 PARTIAL`** | **`1 NOT_RUN`** | **`1 FAIL`** (Total = `20`)

| Criterion ID | Requirement Description | Status | Supporting Evidence & Exact Gap Explanation |
| :---: | :--- | :---: | :--- |
| **`P02-01`** | Comprehensive open-source ASR model discovery covering Persian, multilingual & lightweight CPU families | **`PASS`** | `docs/phase-02/MODEL-DISCOVERY.md` + `MODEL-CANDIDATE-MATRIX.md` (`14` candidate families/variants cataloged). |
| **`P02-02`** | Structured candidate comparison matrix with exact revisions, artifacts, capabilities & exclusions | **`PASS`** | `docs/phase-02/MODEL-CANDIDATE-MATRIX.md` (`AVP-P02-MATRIX-2.0`) with verified SHA-256 artifact hashes. |
| **`P02-03`** | Commercial license verification separating code, weights, tokenizers, runtimes & datasets (`CC-BY-NC`/`UNKNOWN` blocked) | **`PASS`** | `docs/phase-02/LICENSE-COMPLIANCE-REGISTER.md` (`AVP-P02-LICENSE-2.0`); `Apache-2.0`/`MIT`/`CC-BY-4.0` verified; `MMS`/`Seamless` (`CC-BY-NC-4.0`) & `hezarai` (`UNKNOWN`) rejected; FFmpeg GPL/LGPL packaging note documented. |
| **`P02-04`** | Reproducible benchmark protocol & normalized evaluation metric implementation with unit tests | **`PASS`** | `docs/phase-02/BENCHMARK-PROTOCOL.md` + `EVID-04`/`EVID-05`/`EVID-07` (`6/6` metric unit tests PASS). |
| **`P02-05`** | Versioned, verified, multi-domain evaluation dataset covering real target audio with provenance register | **`PARTIAL`** | `docs/phase-02/DATASET-REGISTER.md`: FLEURS `dev` (`25` clips, `277.33s`) was transient (`/tmp` absent), tiny (`4.62 min`), read-only speech; `training/data/*.jsonl` has `0` real audio files; no real Persian podcast/conversational corpus exists on disk. |
| **`P02-06`** | Standardized verbatim & disfluency annotation guideline defined prior to dataset curation | **`PASS`** | `docs/phase-02/DATASET-ANNOTATION-STANDARD.md` (`AVP-P02-ANNOT-STD-2.0`). |
| **`P02-07`** | Real offline CPU execution of shortlisted models on standardized audio with reproducible raw JSON logs | **`PASS`** | `EVID-01` (5 models × 25 WAVs), `EVID-02` (product-fit suite), `EVID-03` (`5/5` recovery repeatability), all raw JSONs SHA-256 verified. |
| **`P02-08`** | Statistical significance testing & Persian/English accuracy baseline quantification on Linux CPU | **`PASS`** | `EVID-01` paired bootstrap (`2,000` resamples, `seed=42`, `95% CI`) in `CPU-BENCHMARK-RESULTS.md`; `Shenava-Rizeh` (`5.71%` FA CER) and `Whisper Turbo` (`5.83%` EN WER) established; `whisper-base-int8` `+15.00 pp` regression and `Qwen3-ASR-0.6B` Persian failure proven (`p < 0.05`). |
| **`P02-09`** | Natural intra-sentence Persian-English code-switching evaluation | **`PARTIAL`** | Only `5` synthetic `fa-en-concat` (`FA + 350ms + EN`) clips measured (`EVID-01`), where all single models failed (`67.82%`–`105.75%` WER). **Zero natural intra-sentence CS audio clips** evaluated and routed dual-model CS is `NOT_RUN`. |
| **`P02-10`** | Spontaneous Persian disfluency preservation (fillers, stutters, false starts) | **`NOT_RUN`** | **Zero annotated spontaneous disfluency audio clips** exist (`DATASET-REGISTER.md`). Core AVAPARDAZ smart-editing accuracy remains unmeasured (**BLOCKER**). |
| **`P02-11`** | Verbatim repetition preservation (preventing silent deduplication) | **`PARTIAL`** | Verified on `Shenava-Rizeh` via 1 controlled real-utterance repetition probe (`EVID-02`, `14/14` words, `0.0%` CER drift). Natural human repetitions and `whisper-large-v3-turbo` repetition behavior are `NOT_RUN`. |
| **`P02-12`** | Word-level timestamp accuracy validated against ground-truth word boundaries | **`PARTIAL`** | `TIMESTAMP-EVALUATION.md`: `Shenava-Rizeh` native CTC token timestamps and offset drift (`0.0`/`3.8 ms`) verified (`EVID-02`/`03`), but **human Praat/TextGrid word-boundary ground truth is `NOT_AVAILABLE`**, CTC emission lag is unmeasured, and `whisper-large-v3-turbo` has **no word timestamps** in `sherpa-onnx` (aligner `NOT_RUN`). |
| **`P02-13`** | CPU latency, cold start & real-time factor (`RTF`) benchmarked on **both** Linux x86_64 and target Apple Silicon M2 (`H1`) | **`PARTIAL`** | Linux `x86_64` measured (`EVID-01`/`02`/`03`), but **`H1_M2_BENCHMARK = NOT_RUN`** (`UNTESTED — PHYSICAL HARDWARE VALIDATION REQUIRED`) and `EVID-01` `whisper-large-v3-turbo` `subsets.en.rtf = 0.0` anomaly remains unresolved. |
| **`P02-14`** | Peak memory (`RSS`) validated against `8 GB` unified memory target (`H1`) including co-residency margin | **`PARTIAL`** | Linux `12 GiB` RSS measured (`165.81–204.5 MiB` Shenava; `1,382.88–1,823.38 MiB` Whisper Turbo), but **Apple M2 `8 GB` unified memory residency & Audition co-residency are `NOT_RUN`**. |
| **`P02-15`** | Long-form audio stability (`30–60 min` continuous recording) with bounded `O(1)` memory | **`PARTIAL`** | `EVID-02` verified `5-min` (`300s`, `12×25s`) chunked `O(1)` stability on `Shenava-Rizeh` (`273.20–279.16 MiB`, `5.96 MiB` drift); **`30–60 min` continuous recording and Whisper long-audio stability are `NOT_RUN`**. |
| **`P02-16`** | Strict offline execution verification across all selected models (zero network calls) | **`PARTIAL`** | Proxy-blackhole verified for `Shenava-Rizeh` (`EVID-01`/`02`/`03`), `whisper-base`, and `Qwen3`. **`whisper-large-v3-turbo-int8` raw JSON records `"offline_verified": false`**, and OS kernel-level air-gap (`unshare -n` / macOS airplane mode) is **`NOT_RUN`**. |
| **`P02-17`** | Repeated-job reliability & determinism soak (`>= 50` sequential runs without crash/leak) | **`PARTIAL`** | `10/10` (`EVID-02`) and `5/5` (`EVID-03`) deterministic runs passed on `Shenava-Rizeh` (`100%` `rc=0`, byte-identical); **`50`-job mixed soak & long-lived daemon memory leak test are `NOT_RUN`**. |
| **`P02-18`** | Single or composed production ASR model approved with full empirical pass across FA, EN, CS, timestamps & target hardware | **`FAIL`** | **No evaluated single model passes all requirements** (`Shenava` fails EN/CS; `Whisper Turbo` fails CS & native word timestamps; `Qwen3` fails FA), and the provisional dual-model + aligner stack has **NOT** been end-to-end benchmarked on real CS/disfluency/Praat data or M2 hardware (`MODEL-SELECTION-REPORT.md`). |
| **`P02-19`** | Architecture Decision Record comparing Single-Model, Dual-Model, ASR + Forced Alignment & Pluggable Provider for Audition + Web | **`PASS`** | Formal `ADR-P02-REC-001` documented in `docs/phase-02/MODEL-SELECTION-REPORT.md` across all 9 required architectural dimensions. |
| **`P02-20`** | Complete, internally consistent Phase-02 documentation set with honest forensic reconciliation of legacy discrepancies | **`PASS`** | All `11/11` documents present under `docs/phase-02/`; all legacy contradictions in `docs/AVAPARDAZ/` explicitly reconciled in Section 4 below; zero fabricated metrics; zero production code edits. |

---

## 4. 16-Point Cross-Document Self-Audit & Legacy Reconciliation

| # | Audit Check | Result | Findings / Reconciliation Action |
| :-: | :--- | :---: | :--- |
| 1 | All 11 required `docs/phase-02/*.md` files exist? | **PASS** | `11 / 11` present (`2` pre-existing preserved + `9` created). |
| 2 | Pre-existing `MODEL-DISCOVERY.md` & `BENCHMARK-PROTOCOL.md` unmodified? | **PASS** | Original byte sizes (`16,395 B` & `6,661 B`) and SHA-256 hashes unchanged. |
| 3 | Historical `docs/AVAPARDAZ/*` files preserved untouched? | **PASS** | All 5 historical docs untouched; contradictions explicitly reconciled rather than hidden. |
| 4 | Raw benchmark JSON files (`EVID-01`/`02`/`03`) preserved untouched? | **PASS** | All 3 SHA-256 digests unchanged. |
| 5 | Legacy `docs/AVAPARDAZ/PHASE-02-ACCEPTANCE-REPORT.md` premature `ACCEPTED` claim reconciled? | **PASS** | Superseded by this report (`BLOCKED`); legacy file admitted M2/Windows `UNTESTED` yet claimed `ACCEPTED` — formally corrected. |
| 6 | Legacy `docs/AVAPARDAZ/MODEL-SELECTION-REPORT.md` `Whisper Turbo Offline: PASS` claim reconciled? | **PASS** | Reconciled against raw `EVID-01` `"offline_verified": false` and `subsets.en.total_inference_sec = 0.0` -> downgraded to **`PARTIAL`**. |
| 7 | Legacy `docs/AVAPARDAZ/PHASE-02-RUNTIME-COMPATIBILITY.md` `"Sub-100ms cold start"` claim reconciled? | **PASS** | Corrected across all Revision 2 docs to exact measured Linux cold start **`1,665–2,128 ms`**. |
| 8 | Legacy `PHASE-02-RUNTIME-COMPATIBILITY.md` `"Qwen3-ASR-0.6B Primary BALANCED"` contradiction reconciled? | **PASS** | Reconciled against `EVID-01` (`56.57%` FA CER) -> `Qwen3-ASR-0.6B-int8` formally **`REJECTED`**. |
| 9 | Compressed archive sizes (`~29.6 MB`, `~538 MB`, `~838 MB`) vs unpacked sizes reconciled? | **PASS** | Standardized everywhere on exact measured unpacked sizes: `36.43 MiB`, `988.59 MiB`, `941.28 MiB`. |
| 10 | `EVID-03` raw JSON `rtf: 0.455` regex-capture quirk transparently explained? | **PASS** | Raw file untouched; exact quotient `0.455 / 14.466 = 0.0315` computed and documented in `CPU-BENCHMARK-RESULTS.md` & here. |
| 11 | `training/data/*.jsonl` fake placeholder manifests exposed & excluded? | **PASS** | Documented as **`UNVERIFIED`** (`0` audio files, fake 16-char hashes) in `DATASET-REGISTER.md` & `LICENSE-COMPLIANCE-REGISTER.md`. |
| 12 | Apple Silicon M2 (`8 GB`) strictly isolated from Linux `x86_64` measurements? | **PASS** | Explicitly marked **`NOT_RUN`** (`UNTESTED — PHYSICAL HARDWARE VALIDATION REQUIRED`) in every benchmark & selection document. |
| 13 | All model revisions (`14ca75f0c5c6`, `41f01f3fe87f`, `5eb144179a02`) & SHA-256 hashes consistent across all 11 docs? | **PASS** | Verified identical across `MODEL-CANDIDATE-MATRIX.md`, `LICENSE-COMPLIANCE-REGISTER.md`, `CPU-BENCHMARK-RESULTS.md`, `MODEL-SELECTION-REPORT.md`, and this file. |
| 14 | `P02-01`..`P02-20` tally (`9 PASS / 9 PARTIAL / 1 NOT_RUN / 1 FAIL`) consistent everywhere? | **PASS** | Verified identical across all documents and Section 11 Recovery Report. |
| 15 | Zero production source code modified (`src/`, `server.ts`, `package.json`)? | **PASS** | `PRODUCTION_CODE_MODIFICATIONS: NONE`. |
| 16 | Zero premature Phase-03..06 artifacts or fine-tuning started? | **PASS** | No `docs/phase-03/`..`docs/phase-06/` created; `TRAINING: NOT_STARTED`; `NEXT_AUTHORIZED_PHASE: NONE`. |

---

## 5. Final Phase-02 Gate Decision

```text
FINAL_PHASE_02_STATUS: BLOCKED
NEXT_AUTHORIZED_PHASE: NONE
APPLE_M2_VALIDATION: NOT_RUN
PRODUCTION_CODE_MODIFICATIONS: NONE
TRAINING: NOT_STARTED
```

**Rationale:** Phase-02 documentation and forensic evidence reconciliation are now **100% complete (`11/11` documents)** and internally consistent. However, **Phase-02 CANNOT be promoted to `ACCEPTED`** because mandatory empirical acceptance gates (`P02-05`, `P02-09`, `P02-10`, `P02-12`, `P02-13`, `P02-14`, `P02-15`, `P02-16`, `P02-17`, and `P02-18`) remain `PARTIAL`, `NOT_RUN`, or `FAIL`.

---

## 6. Mandatory Clearance Checklist to Unblock Phase-02 -> Phase-03

Phase-02 may be re-evaluated for `ACCEPTED` **only after** all six concrete engineering actions below produce verifiable raw artifacts:

1. **Physical Apple Silicon M2 (`8 GB` Unified Memory) Benchmark (`P02-13`, `P02-14`):** Execute `Shenava-Rizeh v1.0`, `whisper-large-v3-turbo-int8` (`sherpa-onnx`), and `whisper.cpp` GGML Q5_0 on real macOS M2 `8 GB` hardware, measuring cold start, RTF, peak RSS, unified memory pressure alongside Adobe Audition, and thermal throttling.
2. **Real Multi-Domain Persian / English / Code-Switching & Disfluency Evaluation Corpus (`P02-05`, `P02-09`, `P02-10`, `P02-11`):** Materialize a persisted, checksummed, license-cleared evaluation archive (outside `/tmp`, outside Git) containing real spontaneous Persian podcasts, natural intra-sentence FA-EN code-switching, verbatim fillers/stutters/false starts, and natural repetitions, annotated per `docs/phase-02/DATASET-ANNOTATION-STANDARD.md`.
3. **Human Word-Boundary Ground-Truth Subset & Multilingual Aligner Evaluation (`P02-12`, `P02-18`):** Create `>= 30–60 min` of Praat/TextGrid human word-boundary ground truth; measure real `MAE / P90 / P95` and CTC emission lag on `Shenava-Rizeh`, and benchmark a native C++/ONNX forced aligner or `whisper.cpp` DTW for English/multilingual cuts.
4. **Clean Single-Pass Offline Verification (`P02-16`):** Re-run `openai/whisper-large-v3-turbo-int8` cleanly (`25/25` single pass) so raw JSON records `"offline_verified": true` and valid `subsets.en` timing, plus run OS-enforced air-gap verification (`unshare -n` on Linux; airplane mode on macOS M2).
5. **Long-Form & Repeated-Job Stability Soaks (`P02-15`, `P02-17`):** Execute a `30–60 min` continuous real recording and a `50`-job mixed stability soak (including long-lived worker RSS leak monitoring) on the selected provider stack.
6. **Final Single/Composed Model Sign-Off (`P02-18`):** Benchmark the end-to-end routed Pluggable Model-Provider stack (`Shenava-Rizeh` + multilingual/aligner contender, plus optional `nvidia/stt_fa_fastconformer_hybrid_large` comparison) against all thresholds and issue a revised `PHASE-02-ACCEPTANCE.md` (`v3.0`).
