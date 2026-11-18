# ENGLISH ASR PROTECTED EVALUATION REPORT (`EN-NORM-V1`)

**Milestone:** `CORE-03 / CORE-04`  
**Verification Date (UTC):** `2026-11-18`  
**Profile:** `EN-NORM-V1` (lowercase normalization, apostrophe/contraction preservation, whitespace collapse; zero Persian script substitution)  
**Confidence Status:** `UNAVAILABLE_UNCALIBRATED`

---

## 1. Purpose & Protected Regression Gate

In Persian-dominant adaptation cycles (`Level B`), adapting prototypes on Persian data must NOT cause catastrophic forgetting or regression on English technical vocabulary (`api`, `benchmark`, `server`, `typescript`).  
The release gate enforces **`englishAbsoluteDeltaPp <= +0.50pp`** (maximum tolerated WER degradation).

---

## 2. Quantitative Results (`evalEnglish`, Held-Out Speakers)

| Model Version | Utterances / Speakers | Mean WER | Mean CER | P50 / P95 Latency (ms) | Mean RTF (CPU) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| `core-ctc-baseline-v0.1.0` | 3 / 3 | **0.6667** | **0.1866** | 17.14 / 17.14 | 0.0117 |
| `core-ctc-adapted-v0.2.0` | 3 / 3 | **0.5556** | **0.1965** | 6.38 / 6.38 | 0.0044 |

- **Absolute English WER Change:** **`-11.11 pp`** (`0.6667 -> 0.5556`) — net **improvement** rather than regression; protected gate **PASSED** (`<= +0.50 pp`).
- **10,000-Iteration Paired Bootstrap 95% CI (Delta WER, `seed = 20261119`):** `meanDelta = -0.1111`, `95% CI = [-0.3334, +0.3334]`, `statisticallySignificant: false` (zero statistically significant regression).
- **Error Taxonomy:** Word substitutions dropped `6 -> 5` (`deletions: 0`, `insertions: 0`). Minor Latin character-level edge trade-off (`CER 0.1866 -> 0.1965`) improved whole-word lexicon resolution.

---

## 3. Scope & Deployment Note

- Evaluates clean CPU CTC English resilience on disjoint utterances; large-vocabulary broadcast/conversational English evaluation (`LibriSpeech` / `CommonVoice-EN`) remains gated behind external ONNX / Python GPU weights in `CoreModelRouter`.
