# BENCHMARK METHODOLOGY & STATISTICAL PROTOCOL — PHASE 3

**Document Version:** `1.0.0-phase3`  
**Normative Reference:** Phase 3 Developer Specification v1.0

---

## 1. Controlled Audio Invariants
1. **Canonical Signal Format:** Every audio file entering a benchmark comparison is validated and resampled to `16,000 Hz`, `1 Channel (Mono)`, `16-bit Signed Integer PCM (WAV)` with an immutable `SHA-256` content digest before any engine receives it.
2. **Paired Execution Requirement:** An experiment comparing Engine A and Engine B is only valid if both engines process the exact same `audioSha256` payload list under identical normalization versions (`FA-STRICT-V1`, `FA-RELAXED-V1`, `EN-NORM-V1`, `MIXED-NORM-V1`).

## 2. Exact Error Rate Formulas
- **Character Error Rate (`CER`):**
  $$\text{CER} = \frac{S_{\text{char}} + D_{\text{char}} + I_{\text{char}}}{N_{\text{ref\_char}}} \times 100$$
- **Word Error Rate (`WER`):**
  $$\text{WER} = \frac{S_{\text{word}} + D_{\text{word}} + I_{\text{word}}}{N_{\text{ref\_word}}} \times 100$$
- **Macro vs. Micro Aggregation:**
  - **Micro-Average CER/WER:** Sum of all edit operations across the corpus divided by total reference characters/words.
  - **Macro-Average CER/WER:** Arithmetic mean of per-sample CER/WER across $K$ samples.

## 3. Paired Bootstrap Resampling & Holm-Bonferroni Correction
- **Iterations:** $B = 10,000$ deterministic bootstrap resamples over paired sample indices (`seed = 20261118`).
- **Confidence Intervals:** 95% empirical percentile interval $[P_{2.5}, P_{97.5}]$ on $\Delta \text{CER} = \text{CER}_A - \text{CER}_B$.
- **Multiple Comparisons Control:** Holm-Bonferroni step-down procedure at family-wise error rate $\alpha = 0.05$.
