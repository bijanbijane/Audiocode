# EXPERIMENT REPRODUCIBILITY & DETERMINISM PROTOCOL — PHASE 3

**Document Version:** `1.0.0-phase3`

---

## 1. Mandatory Reproducibility Artifacts
Every benchmark run, statistical test, and data augmentation operation records:
1. **Audio Content Digest:** `audioSha256` computed over the exact `16kHz Mono PCM WAV` byte stream.
2. **Normalization Policy Version:** Explicit version tag (`FA-STRICT-V1`, `FA-RELAXED-V1`, `EN-NORM-V1`, `MIXED-NORM-V1`).
3. **Deterministic PRNG Seeds:**
   - Zero-Leakage Dataset Splitter: FNV-1a deterministic hash with `seed = 20261118`.
   - 10,000-Iteration Paired Bootstrap Resampler: LCG deterministic PRNG with `seed = 20261118`.
   - Phase 4 Train-Only Audio Augmentation (`A00`..`A05`): Mulberry32 deterministic PRNG seeded per sample and epoch.
4. **Idempotent Task Execution:** `IdempotentExperimentTaskDeduplicator` guarantees that duplicate queue deliveries of `(experimentId, sampleId, engineId)` execute at most once.
