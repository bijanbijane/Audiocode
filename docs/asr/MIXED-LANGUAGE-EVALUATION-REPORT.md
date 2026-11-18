# MIXED PERSIAN-ENGLISH CODE-SWITCHING EVALUATION REPORT (`MIXED-NORM-V1`)

**Milestone:** `CORE-03 / CORE-04`  
**Verification Date (UTC):** `2026-11-18`  
**Normalization Profile:** `MIXED-NORM-V1` (preserves bilingual tokens simultaneously: Persian `ی`/`ک` + ZWNJ handling alongside unmodified Latin technical identifiers in one pass)  
**Protected Gate Threshold:** `mixedAbsoluteDeltaPp <= +0.50 pp`

---

## 1. Quantitative Bilingual Benchmark (`evalMixed`)

| Model Version | Utterances / Speakers | Mean CER | Mean WER | English Code-Switch Errors | P50 / P95 Latency (ms) | Mean RTF (CPU) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| `core-ctc-baseline-v0.1.0` | 3 / 3 | **0.6435** | **1.0000** | 4 | 7.49 / 7.49 | 0.0059 |
| `core-ctc-adapted-v0.2.0` | 3 / 3 | **0.3377** | **0.6389** | 1 | 5.68 / 5.68 | 0.0046 |

- **Absolute Mixed CER Change:** **`-30.58 pp`** (`0.6435 -> 0.3377`), WER improved `1.0000 -> 0.6389`, and English code-switch errors inside Persian frames dropped **`4 -> 1`** (`75%` reduction).
- **10,000-Iteration Paired Bootstrap 95% CI (Delta CER, `seed = 20261120`):** `meanDelta = -0.30577`, `95% CI = [-0.4762, -0.1334]`, `statisticallySignificant: true`.
- **Gate Result:** **PASSED** (`-30.58 pp <= +0.50 pp`).

---

## 2. Language Tag & Normalization Integrity

- `detectTextLanguageTag` accurately classifies bilingual utterances as `'fa-en'` rather than mislabeling English tokens as Persian typos or collapsing spaces between Latin and Persian scripts.
- `buildAllNormalizationProfiles` preserves `RAW_UNMODIFIED` cleanly alongside `MIXED-NORM-V1`, ensuring downstream UI diffing never silently mutates original decoder outputs.
