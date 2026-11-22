# AVAPARDAZ — PHASE-02: DATASET REGISTER & PROVENANCE AUDIT

**Document ID:** `AVP-P02-DATASET-REG-2.0`  
**Execution ID:** `AVP-P02-RECOVERY-002`  
**Date:** `2026-11-22`  
**Evidence Sources:**
- `benchmarks/phase02/prepare_fleurs_dev_eval.py` (`sha256: 7180028070f8183ebee613cb5185d686d0d176686e5e14bd8bfc78b79776354e`)
- `benchmarks/phase02/results-2026-11-20.json` (`sha256: 7abb940d90ae3df4176a66dac9280f105c3b7917541019f823e451ca7b866fe9`)
- `benchmarks/phase02/product-fit-results-2026-11-22.json` (`sha256: f75ff6a32f654c1cd8ed1eb4ce5274926dde6f7ab7bb51a42d40c9753a03648d`)
- `training/data/train_manifest.jsonl`, `validation_manifest.jsonl`, `final_test_manifest.jsonl` (audited `2026-11-22`)
- Local disk audit of `/root/.avapardaz/models/` and `/tmp/avp-p02-bench/` (`2026-11-22`)

---

## 1. Factual Inventory of All Audio Datasets Referenced in Repository

| Dataset ID | Source & Provenance | License | Audio Files Currently on Disk (`2026-11-22`) | Sample Count & Duration | Language Distribution | Speech Style & Quality | Ground Truth | Provenance Status |
| :--- | :--- | :---: | :---: | :--- | :--- | :--- | :--- | :---: |
| **`DS-01` FLEURS-Dev-25** | `google/fleurs` (`fa_ir` `dev` + `en_us` `dev`), built by `benchmarks/phase02/prepare_fleurs_dev_eval.py` | `CC-BY-4.0` | **NO** (`/tmp/avp-p02-bench/` is absent on disk; must re-materialize from upstream tarballs) | `25` clips, **`277.33s` (`4.62 min`)** total (`16 kHz` mono PCM16) | `10` FA (`100.02s`), `10` EN (`88.70s`), `5` `fa-en-concat` (`88.61s` = FA + `350ms` silence + EN) | Clean read Wikipedia sentences (studio/crowdsourced); **not** natural conversational podcasts | Raw FLEURS `dev.tsv` text preserved in `results-2026-11-20.json` | **`PARTIALLY_VERIFIED`** (reproducible upstream provenance, transient local audio, tiny size) |
| **`DS-02` Shenava-Bundled-Wavs** | Bundled inside `/root/.avapardaz/models/sherpa-onnx-nemo-ctc-fa-shenava-rizeh-v1.0-non-streaming-int8-2026-06-26/test_wavs/` | `Apache-2.0` (package) | **YES** (`0.wav`: `462,992 B`, `sha256: abe148a30cb9730778189c4c220ef081b38be56d2a7b4006593ff3a63d3dea7c`; `1.wav`: `81,238 B`, `sha256: 37d0e153cbf87937e372800893f8061ebfe420e3fb0faf35446fcf348fca2ceb`) | `2` clips, **`17.002s`** (`14.466s` + `2.536s`) | `100%` FA (`2` clips) | `0.wav`: colloquial Persian speech; `1.wav`: formal Persian phrase | **NO independent human gold transcript on disk** (used for determinism, timing offset, repetition & stress drift vs clean baseline) | **`PARTIALLY_VERIFIED`** (exact file hashes on disk; speaker/source metadata `UNKNOWN`) |
| **`DS-03` Controlled Perturbations** | Generated ephemerally in `/tmp` by `benchmarks/phase02/run_product_fit_benchmark.py` from `DS-02` | Derived from `DS-02` | Ephemeral (reproducible via script) | `10s` pure silence, `10s` `-45 dBFS` room noise, `1` offset-padded concat (`12.07s`), `1` verbatim repetition (`5.32s`), `4` SNR/tempo probes, `12 × 25s` (`300s`) chunked audio | FA / Silence | Synthetic silence/noise/tempo stress probes — **explicitly NOT counted as natural real-world speech** | Known acoustic offsets & repeated baseline text | **`VERIFIED`** (as engineering stress probes ONLY, never as natural speech corpus) |
| **`DS-04` `training/data/*.jsonl`** | `train_manifest.jsonl` (`2` rows), `validation_manifest.jsonl` (`1` row), `final_test_manifest.jsonl` (`1` row) | Declared `CC-BY-4.0` | **NO (`0` audio files exist!)** | `4` metadata rows (`51.4s` declared, **`0.0s` actual audio**) | Declared `fa` / `fa-en-mixed` | Schema stub only (16-char placeholder hex hashes like `a1b2c3d4e5f60001`) | Text stubs only | **`UNVERIFIED` / NOT REAL AUDIO** (excluded from all Phase-02 claims) |

---

## 2. Dataset Coverage Gap Audit (Observed vs. Production-Grade Phase-02 Requirements)

| Required Evaluation Dimension | Observed Coverage (`2026-11-22`) | Status | Impact on Phase-02 Acceptance |
| :--- | :--- | :---: | :--- |
| **Persian Read Speech (`fa`)** | `10` FLEURS `dev` clips (`100.02s`) + `2` bundled WAVs (`17.00s`) = **`117.02s` (`1.95 min`)** | **`PARTIAL`** | Sufficient for coarse baseline ranking (`p < 0.05` vs `whisper-base` & `Qwen3`), **insufficient** for final production WER confidence intervals across diverse accents/domains. |
| **Persian Colloquial / Conversational Podcasts** | `1` unannotated bundled clip (`0.wav`, `14.47s`); `0` gold-annotated conversational clips | **`NOT_AVAILABLE`** | Cannot guarantee real-world Iranian podcast/interview accuracy (`BLOCKER`). |
| **English Speech (`en`)** | `10` FLEURS `dev` clips (`88.70s` = `1.48 min`) | **`PARTIAL`** | Confirms `whisper-large-v3-turbo` (`5.83%` WER) and `Shenava-Rizeh` failure (`100%` WER), but small sample size. |
| **Natural Intra-Sentence FA-EN Code-Switching** | **`0` natural clips** (`5` concatenated `fa-en-concat` clips = `88.61s` only) | **`NOT_AVAILABLE`** | Concatenated pairs exposed Whisper language-lock, but real intra-sentential Persian+English tech/podcast speech remains **`UNMEASURED`** (`BLOCKER`). |
| **Spontaneous Disfluencies (Fillers, Stutters, False Starts)** | **`0` annotated real clips** | **`NOT_RUN`** | Core AVAPARDAZ smart-editing target (fillers/stutters) has zero empirical recall measurement (`BLOCKER`). |
| **Natural Spoken Repetitions** | `0` natural spontaneous clips (`1` controlled back-to-back real-utterance concat probe only) | **`PARTIAL`** | Proves `Shenava-Rizeh` CTC does not suppress explicit repetitions; Whisper/Qwen and natural repetitions remain `NOT_RUN`. |
| **Manually Annotated Word-Boundary Timestamps** | **`0` human-aligned word-boundary ground-truth clips** | **`NOT_AVAILABLE`** | Cannot compute real-world word-boundary `MAE / P90 / P95` against human Praat/TextGrid annotations (`BLOCKER`). |
| **Speaker Diversity & Demographics** | `10` FA + `10` EN FLEURS utterance IDs (`gender` column parsed in `prepare_fleurs_dev_eval.py`, not logged per sample in `results-2026-11-20.json`) | **`PARTIAL`** | Exact unique speaker count and gender/accent balance not recorded in `results-2026-11-20.json`. |
| **Audio Quality Distribution (Clean / Noisy / Reverb / Mic Variety)** | Clean FLEURS read speech + `2` synthetic white-noise perturbations (`15 dB`, `8 dB`) on `0.wav` | **`PARTIAL`** | No real room reverb, lapel/phone mic, clipping, or overlapping-speaker recordings evaluated. |
| **Frozen Test Set Hygiene** | `google/fleurs` `test` split and `ArmanJR/PESTE-Benchmark` (`871` clips) untouched | **`VERIFIED`** | Zero test-set contamination occurred during Phase-02. |

---

## 3. Dataset Readiness Verdict

- **Overall Dataset Provenance (`P02-05`):** **`PARTIAL`**
- **Dataset Readiness for Production Model Finalization:** **`NOT_READY` (BLOCKED)**
- **Mandatory Acquisition Actions to Unblock:**
  1. Persist a versioned, checksummed local evaluation archive (outside `/tmp`, excluded from Git) with `>= 2h` development and `>= 4h` held-out multi-speaker Persian/English/natural-code-switching audio under verified commercial/research licenses.
  2. Create a manually annotated verbatim subset covering natural Persian fillers, stutters, false starts, and repetitions (see `docs/phase-02/DATASET-ANNOTATION-STANDARD.md`).
  3. Create a manually word-aligned (Praat/TextGrid) ground-truth timestamp subset (`>= 30–60 min`) for real word-boundary error measurement.
  4. Replace or delete the 4 placeholder rows in `training/data/*.jsonl` once real audio manifests exist so stubs are never mistaken for real corpora.
