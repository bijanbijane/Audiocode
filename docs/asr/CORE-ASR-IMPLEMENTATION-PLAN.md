# CORE ASR ENGINE IMPLEMENTATION PLAN

**Program Scope:** Complete, optimize, and verify the independent Persian-English Speech-to-Text Engine (`Level A` inference path + `Level B` trainable adaptation + long-form batch + classified streaming + rigorous FA/EN/Code-Switching benchmarks).  
**Deferred Scope (Out of Current Program):** Meeting summaries, CRM, billing/payments, developer marketplace, SSO, voice-agent workflows, emotion/speaker biometric identification.

---

## Milestone Roadmap

| Milestone | Scope | Verification Criteria | Target Status |
| :--- | :--- | :--- | :--- |
| **CORE-01** | Full codebase, runtime, FFmpeg/Python/GPU hardware audit (`CORE-ASR-ENGINE-AUDIT.md`) | Observed tool output for binaries, weights, `tsc`, `node:test`, `vitest` | **DONE** |
| **CORE-02** | Independent Batch ASR Engine (`/src/asr-core/CoreAudioIngestion.ts`, `CoreAcousticCtcEngine.ts`, `CoreBatchTranscriptionEngine.ts`) | End-to-end FFmpeg decode (WAV/MP3/FLAC/OGG/M4A/WebM -> 16kHz PCM16) + local signal-level ASR decoding without any external cloud API | **NEXT** |
| **CORE-03** | Separate FA (`FA-STRICT-V1`/`FA-RELAXED-V1`), EN (`EN-NORM-V1`), MIXED (`MIXED-NORM-V1`) benchmarks + Error Taxonomy (`PERSIAN/ENGLISH/MIXED-EVALUATION-REPORT.md`) | Speaker/condition-disjoint test harness + 10,000-iteration paired bootstrap CI | Planned |
| **CORE-04** | Reproducible Adapter Training & Hard-Example Adaptation (`CoreAdapterTrainer.ts`) | Verified comparison against baseline + protected EN/MIXED regression gates (`<= +0.5pp`) | Planned |
| **CORE-05** | Long-Form Boundary-Aware Segmentation, Context Overlap, Overlap Stitching & Noise Profiles (`CoreLongFormAsrEngine.ts`) | Tested on short/medium/long multi-minute audio, explicit failed-segment recovery & sample-offset timestamps | Planned |
| **CORE-06** | Evented Stateful Streaming Engine (`CoreStreamingAsrEngine.ts`) + Explicit Classification (`STATEFUL_CHUNKED_STREAMING` / `VAD_SEGMENTED_BATCH` / `NATIVE_INCREMENTAL_STREAMING`) | Live tests across 100ms, 250ms, 500ms, 1000ms chunks; partial/revision/final semantics; bounded queue & overload rejection | Planned |
| **CORE-07** | Inference Optimization, Warm-Up, Memory/RTF Profiling, Concurrency & Minimal Core Router (`CoreModelRouter.ts`) | Measured CPU RTF, Peak RSS MB, P50/P95/P99 latency, concurrent session isolation | Planned |
| **CORE-08** | Core Engine APIs (`/api/v1/asr-core/*`), Security Integration (`AudioIngestionAndUrlGuard`, `StreamingSecurityGuard`), Adobe Audition Studio UI (`Player` + `Selection`) & Production Readiness Gate | Full test suite + Playwright UI verification + `PRODUCTION-READINESS-REPORT.md` | Planned |
