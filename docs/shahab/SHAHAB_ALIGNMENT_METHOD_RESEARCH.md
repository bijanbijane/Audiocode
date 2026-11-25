# SHAHAB-025 Alignment Method Research & Selection

| Method | Granularity | Disk Asset | Selection Status |
|---|---|---|---|
| CTC Frame-Posterior Viterbi Forced Alignment (Log-Domain) | `WORD_LEVEL` | Absent | `RECOMMENDED_NEXT_ACQUISITION` |
| Active Zipformer-Transducer Emission Frame Mapping | `TOKEN_LEVEL` | Absent | `ACTIVE_PRIMARY_WHEN_LOGPROBS_PROVIDED` |
| Acoustic Signal VAD Speech-Region Anchoring (Honest Segment-Level) | `SEGMENT_LEVEL` | Present | `ACTIVE_FALLBACK_HONEST_SEGMENT` |
| Phoneme-Level Forced Alignment (Persian G2P + MFA / Kaldi) | `WORD_LEVEL` | Absent | `RECOMMENDED_NEXT_ACQUISITION` |
| Evenly Distributed / Character-Proportional Word Timing | `TIMING_UNAVAILABLE` | Absent | `REJECTED` |

## Rejected Methods
- **Evenly Distributed / Proportional Word Splitting:** Strictly REJECTED under SHAHAB-025 §19.
- **Treating RNN-T Emission Frames as Exact Phoneme Onsets:** Rejected as phoneme-exact; tagged explicitly as `TOKEN_LEVEL` with emission-delay notice.
