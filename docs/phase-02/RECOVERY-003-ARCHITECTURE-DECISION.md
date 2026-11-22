# AVAPARDAZ — PHASE-02 RECOVERY-003 ARCHITECTURE DECISION UPDATE (`ADR-P02-REC-001`)

**Document ID:** `AVP-P02-REC003-ADR-001`  
**Architecture Decision Record:** `ADR-P02-REC-001` (Empirically Updated under `RECOVERY-003`..`006`)  
**Date (UTC):** `2026-11-22`  
**Production Model Approval Status:** **`NOT_APPROVED` (`PHASE_02_STATUS = BLOCKED`)**  
**Architecture Direction Status:** **`CONFIRMED ON LINUX x86_64 CPU — PENDING PHYSICAL M2 & HUMAN-ANNOTATED CORPUS GATES`**

---

## 1. Decision Summary

The empirical Linux `x86_64` CPU benchmark suite (`EXP1`..`EXP4`, executed strictly offline inside Linux kernel network namespaces `unshare -r -n`) **decisively validates** the pluggable multi-provider native C++ architecture defined in `ADR-P02-REC-001` and **decisively rejects** single-engine `whisper.cpp` on CPU:

| Pipeline Role | Selected Candidate Architecture (Pending M2 & Domain Gates) | License | Empirical Linux CPU Evidence (`EXP1`–`EXP4`) |
| --- | --- | --- | --- |
| **Persian (`fa`) ASR Engine** | `sherpa-onnx-offline` + **`Reza2kn/Shenava-Rizeh v1.0 INT8`** (`FastConformer CTC`) | `Apache-2.0` | Beats Whisper Turbo on identical 25 held-out FA clips by **`-11.203 pp` Norm WER** (`14.53%` vs `25.81%`, 95% CI `[-16.448, -6.129]`) and **`-2.861 pp` Norm CER** (`3.94%` vs `7.18%`, 95% CI `[-4.669, -1.250]`), **`23.5×` faster** (`RTF 0.0359` vs `0.8429`), **`10.4×` lower single-stream RAM** (`196.31 MiB` vs `2,037.02 MiB`). |
| **English (`en`) / Multilingual ASR Engine** | `sherpa-onnx-offline` + **`openai/whisper-large-v3-turbo INT8`** | `MIT` | `25/25` held-out EN clips inside `unshare -r -n`: **`RTF = 0.6487`**, **Norm WER `7.46%`**, Norm CER `2.91%`, Latin Recall `93.74%`, Peak RSS `1,952.80 MiB`, Cold Start `8,146 ms`. |
| **VAD & Long-Audio Segmentation** | `sherpa-onnx-vad-with-offline-asr` + **`Silero VAD v5`** | `MIT` | Verified across `30.00 min` (`1,800.0 s`) unbroken continuous recording (`EXP4`) inside `unshare -r -n`. |
| **English Word-Level Forced Aligner** | **`sherpa-onnx-fa`** + **`english-mfa-v3.1.0`** | `CC-BY-4.0` / `Apache-2.0` | **`25/25` EN clips**, **`WORD_TIMESTAMP_COVERAGE = 1.0000`** (`529/529` words), **`0`** invalid/overlapping intervals, **`RTF = 0.01043`** (`96×` real-time), Peak RSS `169.18 MiB`. |
| **Persian Word-Level Alignment** | **`OPEN BLOCKER`** (`Shenava-Rizeh` native CTC onset `80 ms` stride only; no Persian MFA in `sherpa-onnx` `fa-models`) | `Apache-2.0` (CTC) | `465/465` (`100%`) monotonic onset coverage, **but lacks explicit word end boundary and lacks human Praat TextGrid ground-truth validation**. |

---

## 2. Rejected Alternative: `whisper.cpp v1.9.5` on CPU

Evaluated natively from source (`git commit d1be6fde11ac6e0407606b4e42fe72d34add8037`, `AVX512_VNNI=1`, `OPENMP=1`, `--no-gpu`, 4 threads, `ggml-large-v3-turbo-q5_0.bin`, MIT):

1. **Severe CPU RTF Failure:** Mean CPU RTF = **`5.1497`** on EN (`-ml 1 -dtw`) and **`3.4759`** on FA — violating the mandatory `RTF <= 1.00` gate by **`3.5×–5.1×`** (`~8×` slower than `sherpa-onnx-offline` Whisper Turbo INT8).
2. **DTW Timestamp Instability & Token Fragmentation:** Inter-system comparison against acoustic MFA shows `P90` timing divergence of **`790–1,600 ms`** (`P95 = 835–1,935 ms`) and catastrophic proper-noun subword splitting (`fleurs-en-dev-0103`: `93.75%` norm WER under `-ml 1`).
3. **Verdict:** **REJECTED** for CPU-only production deployment; keep `sherpa-onnx` as the unified C++ runtime family.

---

## 3. Mandatory Gates Required Before Final Production Model Sign-Off

This ADR does **not** authorize `PHASE-03` production implementation. Final sign-off requires:

1. Physical **Apple Silicon M2 (`8 GB`)** qualification (`CPU_ONLY_NO_METAL`, Adobe Audition coexistence, thermal stability, swap growth `<= 512 MiB`) via `tools/phase02/m2-validation/`.
2. Real **conversational Persian podcast**, **natural disfluency (`>= 30 min`)**, and **natural intra-sentence FA–EN code-switching (`>= 30 min`)** evaluation corpora with verified commercial/research rights.
3. **Manual human Praat TextGrid ground truth (`>= 60 min`, `>= 20%` IAA)** and resolution of Persian acoustic word-end alignment accuracy.
4. Independent technical review of all Phase-02 evidence.
