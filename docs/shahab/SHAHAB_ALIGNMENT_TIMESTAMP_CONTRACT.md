# SHAHAB-025 Timestamp & Sample-Index Contract

- **Canonical Representation:** Half-open integer sample intervals `[startSample, endSample)` with explicit `sampleRateHz`, `sourceOffsetSample`, and exact Avapardaz flick conversion (`705,600,000 flicks/sec`).
- **Resampling Lineage:** Explicit `ResamplingLineage` records `originalSampleRateHz`, `processingSampleRateHz`, and exact sample mapping formula.
- **Invariants:** Enforced via `validateAlignmentInvariants()`: monotonicity, non-negative duration, audio bounds containment, transcript immutability, and zero fabricated word splits in segment-only mode.
