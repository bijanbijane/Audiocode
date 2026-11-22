# AVAPARDAZ — PHASE-02 RECOVERY-003 ACCEPTANCE GAP REGISTER (`R03-01`..`R03-20`)

**Document ID:** `AVP-P02-REC003-GAP-001`  
**Execution Series:** `AVP-P02-RECOVERY-003` / `RECOVERY-004` / `RECOVERY-005` / `RECOVERY-006`  
**Date (UTC):** `2026-11-22`  
**FINAL PHASE-02 STATUS:** **`BLOCKED`**  
**NEXT AUTHORIZED PHASE:** **`NONE`** (Phase-03 production implementation strictly prohibited until all `BLOCKED` external gates clear)

---

## 1. Master Gate Reconciliation Matrix

| Gate ID | Phase-02 Acceptance Requirement | Verified Status | Evidence / Exact Gap |
| --- | --- | --- | --- |
| `R03-01` | Production code untouched (`src/`, `server.ts`, `package.json`) | **PASS** | Zero edits to production app source files |
| `R03-02` | Preserve all 11 original Phase-02 docs & 3 historical raw JSONs | **PASS** | All 11 pre-existing `docs/phase-02/*.md` & historical JSONs preserved untouched |
| `R03-03` | Persistent legally-verified audio archive outside `/tmp` + SHA-256 manifest | **PASS** | `avp-p02-v1`: `764` unique clips (`3.5635 h`) in `/root/.avapardaz/datasets/avp-p02-v1/`, `manifest_v1.jsonl` (`0` duplicates) |
| `R03-04` | Dataset duration target (`>= 6.0 h` total, `>= 2.0 h` dev, `>= 4.0 h` held-out) | **FAIL / BLOCKED** | `3.5635 h` verified (`0.6839 h` dev, `1.8899 h` held-out); clip floors met (`200` dev, `563` held-out) |
| `R03-05` | Real conversational Persian podcasts/interviews (legally cleared) | **BLOCKED (External)** | `0.0 h` (YouTube-scraped HF datasets legally rejected) |
| `R03-06` | Natural Persian disfluencies (`>= 30 min`) | **BLOCKED (External)** | `0.0 h` |
| `R03-07` | Natural intra-sentence FA–EN code-switching (`>= 30 min`) | **BLOCKED (External)** | `0.0 h` |
| `R03-08` | Manual human Praat TextGrid word timestamps (`>= 60 min`, `20%` IAA) | **BLOCKED (External)** | `0.0 h` (`validate_textgrid.py` + `4/4` tests + SOP + 60-clip pilot queue ready) |
| `R03-09` | OS-level kernel network-namespace offline proof (`unshare -r -n`) | **PASS** | `00_os_netns_isolation_proof.json` (`net:[82]` vs `net:[2]`, `Errno 101`, zero external routes) + direct inference netns verification |
| `R03-10` | `EXP1`: Real English Whisper Large-v3-Turbo INT8 (`25` held-out EN clips, offline) | **PASS** | `25/25` OK, `RTF = 0.6487`, Norm WER `7.46%`, Peak RSS `1,952.80 MiB` |
| `R03-11` | `EXP1`: Paired Persian comparison (`Shenava-Rizeh` vs `Whisper Turbo`, `25` clips, `1,000` bootstrap) | **PASS** | Shenava wins `-11.203 pp` WER (`p < 0.05`), `-2.861 pp` CER (`p < 0.05`), `23.5×` faster (`RTF 0.0359`), `10.4×` lower 1x RAM |
| `R03-12` | `EXP2`: `whisper.cpp v1.9.5` CPU & DTW evaluation | **PASS (Model Rejected)** | `RTF = 5.1497` (EN) / `3.4759` (FA) — fails CPU `RTF <= 1.00`; DTW jitter `P90 = 790–1,600 ms` |
| `R03-13` | `EXP2`: English acoustic forced alignment (`sherpa-onnx-fa` `english-mfa-v3.1.0`) | **PASS (Structural/Speed)** | `25/25` clips, `100%` word coverage (`529/529`), `0` invalid/overlapping intervals, `RTF = 0.01043`, `169.18 MiB`; human Praat error `NOT_AVAILABLE` |
| `R03-14` | `EXP2`: Persian word-level alignment audit | **PARTIAL / BLOCKED** | No Persian MFA in `sherpa-onnx` `fa-models`; Shenava native CTC emits `100%` (`465/465`) monotonic onsets (`80 ms` stride) without explicit end boundary or Praat GT |
| `R03-15` | `EXP3`: `50` consecutive real mixed inference/alignment jobs (offline) | **PASS** | `50/50` validated jobs (`25` Shenava FA, `15` MFA EN, `10` Turbo EN), `0` crashes, `0` exceptions, `0` corrupted outputs |
| `R03-16` | `EXP4`: Genuine unbroken `30.00 min` (`1,800.0 s`) continuous audio execution (offline) | **PASS (Linux CPU)** | LibriVox *Bleak House* Sec. 3 (`59.39 min` CC0-1.0 master), `[0.0, 1800.0)` exact coverage (`5/5` windows `rc=0`, `0` gaps/duplicates), `249` segs (`3,923` words), `RTF 0.6812`, Peak RSS `2,289.85 MiB`, `0` discontinuities; zero reference transcript WER claimed |
| `R03-17` | Interruption-resilient atomic checkpoint coordinator & `>= 5` fault-injection tests | **PASS** | `checkpoint_coordinator.py` + `11/11` coordinator/interruption tests (`21/21` total Phase-02 unit tests PASS) |
| `R03-18` | Portable Apple Silicon M2 (`8 GB`) Test Kit prepared & preflight-verified | **PASS (Kit Only)** | `tools/phase02/m2-validation/` verified (`bash -n`, `py_compile`, `--dry-run-preflight`, Linux fail-safe abort `rc=10`) |
| `R03-19` | Physical Apple Silicon M2 (`8 GB`) + Adobe Audition coexistence + thermal validation | **BLOCKED (`NOT_RUN`)** | `M2_HARDWARE = NOT_AVAILABLE` in Linux container |
| `R03-20` | Commercial license compliance & independent technical review | **PARTIAL (`REVIEW_PENDING`)** | All evaluated candidate runtimes/models are permissive (`MIT` / `Apache-2.0` / `CC-BY-4.0` / `CC0-1.0`); independent human sign-off pending after external blockers close |

---

## 2. Exact Remaining Blockers Preventing `PHASE_02_STATUS = ACCEPTED`

1. **Physical Apple Silicon M2 (`8 GB`) Qualification (`NOT_RUN`):** CPU-only inference (`NO_METAL`), unified memory pressure, swap growth `<= 512 MiB`, Adobe Audition coexistence, and sustained thermal validation must execute on real M2 hardware via `tools/phase02/m2-validation/`.
2. **Real Conversational Persian, Disfluency & Code-Switching Corpora (`0.0 h`):** Legally cleared conversational Persian podcasts, `>= 30 min` natural disfluencies, and `>= 30 min` natural intra-sentence FA–EN code-switching recordings are required (plus closing the `2.44 h` shortfall to reach `>= 6.0 h` total / `>= 4.0 h` held-out).
3. **Manual Human Praat TextGrid Ground Truth (`0.0 h`):** `>= 60 min` of human-verified word-boundary TextGrids (`>= 20%` double-annotated IAA) are required to certify edit-grade English & Persian boundary precision (`P90`/`P95` ms).
4. **Persian Word-End Alignment Solution:** No Persian MFA acoustic model exists in `sherpa-onnx` `fa-models`; `Shenava-Rizeh` CTC emits `80 ms`-stride onset peaks only and requires either a dedicated Persian forced aligner or Praat-validated acoustic end-boundary estimation.
5. **Independent Technical Review:** Final sign-off once Blockers 1–4 are closed.
