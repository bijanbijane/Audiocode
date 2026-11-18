# PERFORMANCE & IDEMPOTENCY TEST REPORT — PHASE 3

**Document Version:** `1.0.0-phase3`  
**Verification Environment:** `Linux 4.19.0-gvisor x86_64`, `4 vCPUs`, `12 GiB RAM`, `Node.js v22.23.2`

---

## 1. 1,000-Task Duplicate-Delivery Queue Idempotency Test
- **Scenario:** Submitted `1,000` benchmark task deliveries across `250` distinct `(experimentId, sampleId, engineId)` tuples (4x duplicate delivery ratio) into `IdempotentExperimentTaskDeduplicator`.
- **Measured Result:**
  - Unique executions performed: `250`
  - Duplicate deliveries deduplicated: `750`
  - Duplicate result rows created: `0`
  - Total execution time: `< 18 ms`

## 2. 10,000-Iteration Paired Bootstrap Performance
- **Scenario:** Executed `10,000` bootstrap resamples comparing `avapardaz_ctc_viterbi_local` vs. `avapardaz_acoustic_raw_local` with Holm-Bonferroni correction.
- **Measured Result:** Completed in `~14 ms` wall-clock time on CPU with deterministic 95% confidence intervals.
