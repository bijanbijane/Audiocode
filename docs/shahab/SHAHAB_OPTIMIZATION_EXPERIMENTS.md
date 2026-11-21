# SHAHAB Controlled Optimization Experiments (Alternating A/B)

| ID | Experiment | Baseline Median | Candidate Median | Speedup | Exact Persian Match | Decision |
|---|---|---:|---:|---:|---|---|
| OPT-001 | Precomputed FFT-512 Twiddle/Bit-Reversal Tables & Compact Sparse Mel Filterbank Bounds | 188.417 ms | 100.549 ms | 46.63% | YES | **ACCEPTED** |
| OPT-002 | Per-Frame Joiner Context Deduplication & O(K) Insertion Top-K in Modified Beam Search | 567.485 ms | 294.695 ms | 48.07% | YES | **ACCEPTED** |
| OPT-003 | Eliminating 0.6s Kaldi Tail Padding to Shorten Encoder Frame Count | 970.497 ms | 927.448 ms | 4.44% | YES | **REJECTED** |

### OPT-001 — Precomputed FFT-512 Twiddle/Bit-Reversal Tables & Compact Sparse Mel Filterbank Bounds
- **Decision:** ACCEPTED
- **Reason:** Measured 46.63% faster FBANK extraction on 24.2s audio (188.417ms -> 100.549ms) with max abs diff 8.58e-6 and 100% identical Persian transcript.
- **Numerical Max Abs Diff:** 0.000008583
- **Decoder/Joiner Calls:** N/A -> N/A

### OPT-002 — Per-Frame Joiner Context Deduplication & O(K) Insertion Top-K in Modified Beam Search
- **Decision:** ACCEPTED
- **Reason:** Reduced PRECISION (beam=8) Joiner calls 2668 -> 1506 and median decode latency 567.485ms -> 294.695ms (48.07% faster) with 100% identical Persian transcript.
- **Numerical Max Abs Diff:** 0
- **Decoder/Joiner Calls:** 2668 -> 1506

### OPT-003 — Eliminating 0.6s Kaldi Tail Padding to Shorten Encoder Frame Count
- **Decision:** REJECTED
- **Reason:** REJECTED on safety grounds: Zipformer2 stateless7 subsampling requires >=0.6s right-context tail padding to prevent final-word truncation on speech ending near EOF; minor frame savings do not justify boundary-truncation risk.
- **Numerical Max Abs Diff:** N/A
- **Decoder/Joiner Calls:** 952 -> 906
