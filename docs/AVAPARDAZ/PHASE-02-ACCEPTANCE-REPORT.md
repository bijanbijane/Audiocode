# AVAPARDAZ — PHASE-02 ACCEPTANCE REPORT (`AVP-P02-001`)

**Document ID:** `AVP-P02-ACCEPT-1.0`  
**Phase:** `PHASE-02` — Open-Source Model Discovery & Multi-Device CPU Benchmark (`MASTER v3.1`)  
**Date:** `2026-11-20`  
**Final Phase Verdict:** **`ACCEPTED`** (`7 / 7` Phase-02 Acceptance Gates Satisfied; physical macOS/Windows hardware testing honestly scoped to `PHASE-08`/`15` external blockers).

---

## 1. Phase-02 Acceptance Gate Verification Matrix

| Gate ID | Mandatory Phase-02 Requirement | Status | Direct Reproducible Evidence |
| :---: | :--- | :---: | :--- |
| `G02-01` | Reconcile roadmap/state docs with filesystem reality before starting | **`PASS`** | Verified `PHASE-01 == ACCEPTED` (`MASTER v3.1`), `0` binary weights committed to repo, clean separation of code/weights/data. |
| `G02-02` | Audit real open-source ASR candidates & commercial distribution licenses | **`PASS`** | `PHASE-02-LICENSE-AUDIT.md` & `PHASE-14-COMMERCIAL-READINESS.md`: cleared `Apache-2.0` (`Shenava-Rizeh`, `sherpa-onnx`, `Qwen3-ASR`) and `MIT` (`Whisper`, `onnxruntime-web`); rejected `CC-BY-NC`. |
| `G02-03` | Acquire legally licensed real Persian, English & Bilingual speech audio (zero synthetic metrics) | **`PASS`** | `benchmarks/phase02/prepare_fleurs_dev_eval.py`: `25` real `CC-BY-4.0` Google FLEURS `dev` WAVs (`277.33s`: `10` FA, `10` EN, `5` FA-EN concat), verified SHA-256 per file, zero audio committed to repo. |
| `G02-04` | Execute reproducible CPU-only benchmarks with strict offline isolation | **`PASS`** | `benchmarks/phase02/run_cpu_bakeoff.py` + `results-2026-11-20.json`: `5` real ONNX models benchmarked on `25 / 25` WAVs (`rc=0`, `offline_verified=true` under `http_proxy=127.0.0.1:9`, `HF_HUB_OFFLINE=1`). |
| `G02-05` | Measure Raw/Normalized Persian CER, English WER, Code-Switch Latin Recall, RTF, Cold Start, Peak RSS & 95% CIs | **`PASS`** | `MODEL-SELECTION-REPORT.md` + `results-2026-11-20.json` (`2,000`-resample `paired_bootstrap_ci`, `seed=42`); `6 / 6` unit tests PASS (`test_evaluation_metrics.py`). |
| `G02-06` | Evaluate Native CPU (`P1` Audition) vs Browser ONNX/WASM (`P2` Web) compatibility | **`PASS`** | `PHASE-02-RUNTIME-COMPATIBILITY.md` + `MODEL-PROVENANCE.md` (verified `sherpa-onnx v2.0.2` + 4 `onnxruntime-web` `.wasm` SHA-256 digests). |
| `G02-07` | Assign evidence-backed models to `AVP_MODEL_LITE` / `BALANCED` / `QUALITY` & record SHA-256 provenance | **`PASS`** | Updated `MODEL-REGISTRY.md` (8-state matrix), `MODEL-PROVENANCE.md` (exact byte lengths & SHA-256), and `DECISION-LOG.md` (`ADR-023`, `ADR-024`). |

---

## 2. Explicit Scope Limitations Honesty Statement

- All Phase-02 CPU measurements were executed on the available Linux `x86_64` container (`4` vCPUs, `12 GiB` RAM, `G0_CPU_ONLY`). Consumer Intel/AMD Windows laptops and Apple Silicon MacBooks remain `[UNTESTED ON PHYSICAL DEVICE]` and are explicitly tracked as external blockers in `PHASE-15-FINAL-ACCEPTANCE-DECISION.md`.
- The `25`-utterance FLEURS `dev` benchmark is clean read speech and proves baseline architectural suitability, NOT final real-world noisy/spontaneous podcast accuracy (which requires a larger held-out beta corpus).
