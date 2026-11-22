# AVAPARDAZ — PHASE-02 RECOVERY-003..006 EXECUTION & RECONCILIATION REPORT

**Document ID:** `AVP-P02-REC003-EXEC-001`  
**Execution Lineage:** `AVP-P02-RECOVERY-003` -> `RECOVERY-004` -> `RECOVERY-005` -> `RECOVERY-006`  
**Architecture Reference:** `ADR-P02-REC-001`  
**Date (UTC):** `2026-11-22`  
**Production Code Modification:** **`PROHIBITED — ZERO EDITS VERIFIED`** (`481` production files untouched)  
**Final Phase-02 Gate Verdict:** **`BLOCKED`** (`NEXT_AUTHORIZED_PHASE = NONE`)

---

## 1. Executive Summary

All Linux-feasible empirical benchmarks, tooling, interruption-resilience tests, OS-level kernel network-namespace offline proofs, and documentation deliverables under `AVP-P02-RECOVERY-003`..`006` have been **completed, cryptographically hashed (`69/69` files verified via `sha256sum -c EVIDENCE_MANIFEST.sha256`), and reconciled**:

| Program Track | Status | Key Verified Evidence |
| --- | :---: | --- |
| **Persistent Dataset Archive (`avp-p02-v1`)** | **PARTIAL (`3.5635 h`)** | `764` unique legally-cleared clips (`CC-BY-4.0` / `CC0-1.0`), `0` duplicates, `manifest_v1.jsonl` SHA-256 verified; YouTube-scraped HF datasets legally rejected; external conversational/disfluency/CS/Praat corpora remain `0.0 h`. |
| **OS-Level Offline Proof (`unshare -r -n`)** | **PASS (Linux CPU)** | `00_os_netns_isolation_proof.json` (`net:[82]` vs `net:[2]`, `Errno 101`) + `05_direct_inference_netns_proof.json` proving live `/proc/<pid>/ns/net` on actual `sherpa-onnx-offline` Whisper EN (`PID 10872`, `net:[276]`) & Shenava FA (`PID 10879`, `net:[278]`), plus live `EXP4` `sherpa-onnx-vad-with-offline-asr` (`PID 11051`, `net:[288]`). |
| **`EXP1` (Offline EN + Paired FA Bake-Off)** | **VERIFIED** | `25` EN Whisper Turbo (`RTF 0.6487`, Norm WER `7.46%`, P50 `6.25%`, P90 `13.90%`, `1,952.8 MiB`) + `25` paired FA (`Shenava-Rizeh` beats `Whisper Turbo` by `-11.203 pp` WER & `-2.861 pp` CER, 1,000-iter bootstrap `p < 0.05`, `23.5×` faster `RTF 0.0359`, `10.4×` lower 1x RSS `196.31 MiB`). |
| **`EXP2` (`whisper.cpp v1.9.5` + Forced Alignment)** | **VERIFIED** | `whisper.cpp v1.9.5` **REJECTED** on CPU (`RTF 5.1497` EN / `3.4759` FA, DTW `P90` divergence `790–1,600 ms`); `sherpa-onnx-fa` (`english-mfa-v3.1.0`) **PASS** (`25/25` EN, `100%` coverage `529/529` words, `0` invalid/overlapping intervals, `RTF 0.01043`, `169.18 MiB`); Persian MFA absent in `fa-models` (Shenava CTC `100%` monotonic onsets, `80 ms` stride, no end boundary, no Praat GT). |
| **`EXP3` (50-Job Offline Stability Soak)** | **VERIFIED (`PASS`)** | `50/50` real netns-isolated mixed jobs (`25` Shenava FA, `15` MFA EN, `10` Turbo EN), `0` crashes, `0` exceptions, `0` corrupted outputs, `15/15` TextGrids valid (`40/40` total generated TextGrids valid on disk). |
| **`EXP4` (Continuous 30.00-Min Unbroken Audio)** | **COMPLETED (`PASS`)** | LibriVox *Bleak House* Sec. 3 (`3,563.337 s` unbroken CC0-1.0 master), `[0.0, 1800.0)` exact contiguous coverage (`0` missing / `0` duplicate intervals), `5/5` windows `rc=0`, `249` VAD segments (`3,923` words), `RTF = 0.6812`, Peak RSS `2,289.85 MiB`, max 2nd-half steady drift `40.0 MiB` (`0.0 MiB` on `win0` & `win1b`), `0` discontinuities, `0` overlaps. |
| **Checkpoint Coordinator & Interruption Suite** | **PASS (`21/21`)** | `11/11` coordinator & fault-injection tests (including **6** simulated interruption tests covering inference, serialization, checkpoint write, window completion, and status update + stale lock) + `6/6` metric tests + `4/4` TextGrid tests. |
| **Portable Apple Silicon M2 (`8 GB`) Test Kit** | **VERIFIED (`NOT_RUN`)** | `tools/phase02/m2-validation/` syntax/preflight/fail-safe (`exit 10`) verified and patched to parse both `stdout` & `stderr` JSON on `sherpa-onnx v2.0.2`. Physical M2 hardware unavailable in container. |

---

## 2. Interruption Recovery Chronology (`RECOVERY-005` -> `RECOVERY-006`)

1. **Forensic Process Inspection (`AVP-P02-RECOVERY-006` Section 3):** On resume from the cancelled `RECOVERY-005` session, direct `/proc` and filesystem inspection confirmed **Case B (Process Completed Cleanly)** — `exp4_win1a.json` (`600..900s`, `rc = 0`, `RTF = 0.6919`, `37` segments, `676` words) had finished and committed atomically prior to exit with zero orphaned processes.
2. **Zero Duplicate Re-Execution:** Preserved `EXP1`, `EXP2`, `EXP3`, `exp4_win0.json` (`0..600s`), and `exp4_win1a.json` (`600..900s`) untouched; executed only the 3 remaining contiguous `300s` windows (`1b: 900..1200s`, `2a: 1200..1500s`, `2b: 1500..1800s`) with `--threads 3` (leaving 1 CPU core free for stable container control-plane responsiveness) and ran `finalize`.
3. **Defects Found & Autonomously Repaired During Audit:**
   - Added full `AVP-P02-RECOVERY-006` Section 4.1 source metadata, `[0, 1800)` gap/overlap detector, and Section 4.4 structured measurement ledger to `run_exp4_continuous_30m.py`.
   - Added 5 targeted interruption-recovery tests covering all 5 required interruption stages to `test_checkpoint_coordinator.py`.
   - Produced `05_direct_inference_netns_proof.json` proving live `/proc/<pid>/ns/net` isolation on actual `sherpa-onnx-offline` EN/FA processes with proxy env vars stripped.
   - Patched `tools/phase02/m2-validation/m2_runner.py` to scan both `stdout` and `stderr` for `sherpa-onnx v2.0.2` JSON transcript objects (eliminating an empty-text bug on macOS M2 runs).

---

## 3. Why `PHASE_02_STATUS` Strictly Remains `BLOCKED`

Completing all Linux-feasible benchmarks (`EXP1`–`EXP4`) does **not** relax Phase-02 exit gates. The following external blockers strictly prevent `PHASE-03` authorization:

1. **Physical Apple Silicon M2 (`8 GB`) Qualification (`NOT_RUN`):** CPU-only execution, swap growth `<= 512 MiB`, Adobe Audition coexistence, and sustained thermal validation must run on real M2 hardware.
2. **Real Conversational Persian, Natural Disfluencies (`>= 30 min`) & Intra-Sentence Code-Switching (`>= 30 min`):** Currently `0.0 h` (total verified corpus is `3.5635 h` vs `>= 6.0 h` target).
3. **Manual Human Praat TextGrid Ground Truth (`>= 60 min`, `20%` IAA):** Currently `0.0 h`.
4. **Persian Word-End Alignment Accuracy:** No Persian MFA acoustic model in `sherpa-onnx` `fa-models`; `Shenava-Rizeh` native CTC provides `80 ms` onset peaks only without human Praat boundary error certification.
5. **Independent Technical Review:** Pending closure of Blockers 1–4.

---

## 4. Document Cross-Reference (`docs/phase-02/`)

- `RECOVERY-003-EXECUTION-REPORT.md` (this report)
- `RECOVERY-003-EVIDENCE-REGISTER.md` (all model, dataset, and evidence SHA-256 digests)
- `RECOVERY-003-DATASET-REPORT.md` (`avp-p02-v1`, legal exclusions, Praat tooling, shortfalls)
- `RECOVERY-003-M2-QUALIFICATION.md` (portable M2 kit verification & physical runbook)
- `RECOVERY-003-OFFLINE-VERIFICATION.md` (`unshare -r -n` kernel isolation + live per-PID proof + `EXP1` paired bootstrap)
- `RECOVERY-003-ALIGNMENT-REPORT.md` (`whisper.cpp v1.9.5` DTW vs `sherpa-onnx-fa` MFA EN vs `Shenava-Rizeh` CTC)
- `RECOVERY-003-STABILITY-REPORT.md` (`EXP3` 50/50 jobs + `EXP4` 30-min continuous audio)
- `RECOVERY-003-ARCHITECTURE-DECISION.md` (updated `ADR-P02-REC-001`)
- `RECOVERY-003-ACCEPTANCE-GAP.md` (`R03-01`..`R03-20` gate ledger & blockers)
