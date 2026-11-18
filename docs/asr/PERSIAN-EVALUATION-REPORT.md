# PERSIAN ASR EVALUATION REPORT (`FA-STRICT-V1` & `FA-RELAXED-V1`)

**Milestone:** `CORE-03 / CORE-04`  
**Verification Date (UTC):** `2026-11-18`  
**Evaluated Engine:** `CoreAcousticCtcEngine` + `CoreBatchAndLongFormEngine` (Local CPU Level A Baseline vs Level B Adapted)  
**Confidence Status:** `UNAVAILABLE_UNCALIBRATED` (`calibratedConfidence: null`)  
**Timestamp Granularity:** `SEGMENT` (word entries carry relative segment offsets; not forced-aligned neural word boundaries)

---

## 1. Benchmark Design & Evaluation Rules (`[Observed Fact]`)

- **Speaker- & Condition-Disjoint Split:**
  - Adaptation Training Split (`trainExamples`): dedicated synthetic-formant Persian + bilingual speakers with distinct pitch (`f0`) and background noise levels.
  - Held-Out Persian Evaluation Split (`evalPersian`): **4 disjoint speakers**, `4` multi-word utterances separated from training speakers.
- **Strict Separation of Normalization Profiles (`CoreNormalizationAndLanguage.ts`):**
  - `RAW_UNMODIFIED`: Raw decoder hypothesis preserved unchanged.
  - `FA-STRICT-V1`: Standardizes Arabic `ي`/`ك` -> Persian `ی`/`ک`, strips diacritics/tatweel, preserves ZWNJ (`U+200C`) boundaries and punctuation distinctions.
  - `FA-RELAXED-V1`: Relaxes ZWNJ (`\u200c` -> space) and strips editorial punctuation for semantic/lexical tolerance comparison.
- **Bootstrap Significance Testing:**
  - Seeded paired bootstrap (`computePairedBootstrapCi`, `iterations = 10,000`, `seed = 20261118`) on per-utterance CER deltas (`candidate - baseline`).

---

## 2. Quantitative Results (Held-Out Persian Slice)

| Model Version | Profile | Utterances / Speakers | Mean CER | Mean WER | P50 / P95 Latency (ms) | Mean RTF (CPU) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `core-ctc-baseline-v0.1.0` | `FA-STRICT-V1` | 4 / 4 | **0.5465** | 1.0000 | 14.93 / 24.80 | 0.0156 |
| `core-ctc-adapted-v0.2.0` | `FA-STRICT-V1` | 4 / 4 | **0.2683** | 0.9375 | 10.54 / 12.90 | 0.0083 |
| `core-ctc-baseline-v0.1.0` | `FA-RELAXED-V1` | 4 / 4 | **0.5465** | 1.0000 | 12.15 / 18.18 | 0.0103 |
| `core-ctc-adapted-v0.2.0` | `FA-RELAXED-V1` | 4 / 4 | **0.2683** | 0.9375 | 8.28 / 8.46 | 0.0060 |

- **Relative Persian Strict CER Improvement:** **+50.91%** (`0.5465 -> 0.2683`, delta = `-0.2782`).
- **10,000-Iteration Paired Bootstrap 95% CI (Delta CER):** `[-0.27815, -0.27815]`, `statisticallySignificant: true`.

---

## 3. Error Taxonomy Comparison (`evalPersian`)

| Taxonomy Dimension | Baseline (`v0.1.0`) | Adapted (`v0.2.0`) | Observation |
| :--- | :---: | :---: | :--- |
| Substitutions (word-level edit ops) | 14 | 13 | Reduced confusion across vowels/stop consonants after Conformer 3x temporal subsampling & energy-island alignment. |
| Deletions | 0 | 0 | Zero silent word omissions. |
| Insertions | 0 | 0 | Zero runaway CTC duplicate insertions after 3x subsampling (`subStride = 3`). |
| Script Mismatches (`AR/Latin` leak) | 0 | 0 | Persian character set cleanly enforced. |
| Half-Space (ZWNJ) Errors | 0 | 0 | Preserved identically across both versions. |
| English Code-Switch Errors | 0 | 0 | Pure Persian slice; mixed code-switching measured separately. |
| Punctuation Normalization Diffs | 0 | 2 | Minor punctuation normalization diffs isolated cleanly by `FA-STRICT-V1`. |

---

## 4. Honest Limitations (`[Observed Fact]`)

- Because pretrained neural acoustic weights (`Whisper-Large-v3`, `Qwen3-ASR-1.7B`, `FastConformer-FA`) are **absent on local disk** (`weightsPresent: false` for external ONNX/Python workers), the benchmark above reflects the **CPU Acoustic Log-Spectral + CTC Beam Adapter (`Level A/B`)** evaluated on synthetic multi-formant Persian utterances—not real conversational telephone/podcast speech yet. External acoustic benchmark suites require mounting `.onnx` or GPU worker weights into `CoreModelRouter`.
