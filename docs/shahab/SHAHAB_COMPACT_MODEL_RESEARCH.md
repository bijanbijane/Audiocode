# SHAHAB-020 Compact Model Research & Package Footprint Report

- **Active Approved Model Protected:** `true` (`INHERITED-PERSIAN-ASR-CORE`)
- **Sub-100 MiB Uncompressed Runtime Candidate Available:** `false`
- **Recommendation:** Retain verified Variant A (110.41 MiB uncompressed, Apache-2.0) as active baseline; use Variant D gzip (55.66 MiB) solely for network transport compression; keep Variant C INT4 BLOCKED until external quantization + Persian WER evaluation is verified.

| Candidate | Uncompressed MiB | Transport MiB | Eligibility | License |
|---|---:|---:|---|---|
| CAND-A-ACTIVE-INT8 | 110.41 | 94.65 | **RELEASE_CANDIDATE_ELIGIBLE** | Apache-2.0 (LICENSE + NOTICE verified) |
| CAND-B-LOSSLESS-STRIPPED | 110.09 | 94.65 | **BENCHMARK_ELIGIBLE** | Apache-2.0 inherited |
| CAND-C-INT4-WEIGHT-ONLY | N/A | N/A | **BLOCKED** | Apache-2.0 inherited |
| CAND-D-GZIP-TRANSPORT | 110.41 | 94.65 | **RESEARCH_ONLY** | Apache-2.0 inherited |
