# SHAHAB-015 — Resilience Architecture & Fault Containment Boundaries

- **Schema Version:** `1.0.0`
- **Engine Version:** `SHAHAB-R2.0.0-RELEASE-CANDIDATE`
- **Frozen Neural Core:** `INHERITED-PERSIAN-ASR-CORE` (0 trainable parameters; weights untouched)
- **Entry Gate State:** `PARTIALLY_VERIFIED`

## Entry Gate Inspection
| Prerequisite | State | Inspected Files | Limitations |
|---|---|---|---|
| SHAHAB-013 Release & Artifact Integrity | `PARTIALLY_VERIFIED` | `src/shahab/ShahabReleaseHardening.ts`, `docs/shahab/SHAHAB_RELEASE_MANIFEST.json`, `docs/shahab/SHAHAB_SECURITY_VERIFICATION.json` | External cryptographic signing infrastructure not provisioned (automatic production rollout disabled). |
| SHAHAB-014 Operational Observability & Safe Lifecycle | `PARTIALLY_VERIFIED` | `src/shahab/ShahabOperationsGovernance.ts`, `docs/shahab/SHAHAB_OPERATIONAL_STATE.json`, `docs/shahab/SHAHAB_RUNTIME_EVENTS.jsonl` | External remote telemetry collector endpoint is intentionally disabled by default (local-first privacy).; Automatic rollout remains disabled pending SHAHAB-013 cryptographic signing. |
| Unified Local/Cloud Execution Architecture | `VERIFIED` | `src/shahab/ShahabEngineUnified.ts`, `src/processing-engine/UnifiedProcessingContract.ts` | Browser WASM execution and Native sherpa-onnx C++ binary are not verified in this Linux CPU sandbox. |
| Audio-Processing Job Lifecycle | `PARTIALLY_VERIFIED` | `src/reliability/OperationLifecycleManager.ts`, `src/shahab/ShahabEngineUnified.ts` | Prior to SHAHAB-015, SHAHAB ASR jobs did not persist stage-level crash-recovery checkpoints. |
| Existing Persistence & Crash Recovery Mechanisms | `VERIFIED` | `src/runtime/CrashRecoveryAndSessionLock.ts`, `src/reliability/CrashSafeRecoveryCoordinator.ts`, `src/shahab/ShahabEvidenceStore.ts` | Filesystem rename durability varies across OS/filesystems; parent-directory fsync is best-effort on non-POSIX hosts. |
| Existing Cancellation & Interruption Behavior | `VERIFIED` | `src/shahab/ShahabEngineUnified.ts`, `src/shahab/ShahabZipformerEngine.ts` | In-flight native/WASM ONNX kernel invocations cannot be preempted mid-op; cancellation takes effect at chunk/stage boundaries. |
| Existing Error Handling & Retry Policies | `VERIFIED` | `src/reliability/ErrorClassifier.ts`, `src/reliability/RecoveryPolicy.ts`, `src/shahab/ShahabEngineUnified.ts` | None |

## Real Pipeline Fault-Containment Boundaries (12 Stages)
| # | Boundary | Real Code | Retry Safety | Resumable Checkpoint | Data-Loss Risk |
|---|---|---|---|---|---|
| 1 | Audio Ingestion (`B01_AUDIO_INGESTION`) | `src/shahab/ShahabEngineUnified.ts`, `src/shahab/ShahabZipformerEngine.ts` | `IDEMPOTENT_SAFE` | NO | `NONE` |
| 2 | Audio Validation (`B02_AUDIO_VALIDATION`) | `src/shahab/ShahabEngineUnified.ts`, `src/shahab/ShahabZipformerEngine.ts` | `NON_RETRYABLE_DETERMINISTIC` | YES | `NONE` |
| 3 | Preprocessing (Mono 16kHz Normalization & Chunking) (`B03_PREPROCESSING`) | `src/shahab/ShahabZipformerEngine.ts`, `src/shahab/ShahabEngineUnified.ts` | `IDEMPOTENT_SAFE` | NO | `LOW_TEMP_ONLY` |
| 4 | Model & Tokenizer Initialization (`B04_MODEL_INITIALIZATION`) | `src/shahab/ShahabZipformerEngine.ts`, `src/shahab/ShahabReleaseHardening.ts`, `src/shahab/ShahabArtifactAcquisition.ts` | `REQUIRES_CLEAN_REINIT` | NO | `NONE` |
| 5 | Feature Extraction (80-dim Kaldi Log-Mel FBANK) (`B05_FEATURE_EXTRACTION`) | `src/shahab/ShahabZipformerEngine.ts` | `IDEMPOTENT_SAFE` | YES | `LOW_TEMP_ONLY` |
| 6 | Zipformer Encoder Execution (`B06_ENCODER_EXECUTION`) | `src/shahab/ShahabZipformerEngine.ts` | `REQUIRES_CLEAN_REINIT` | YES | `MEDIUM_PARTIAL_PROGRESS` |
| 7 | Transducer Decoder & Joiner Execution (Greedy / Adaptive Beam) (`B07_DECODER_EXECUTION`) | `src/shahab/ShahabZipformerEngine.ts`, `src/shahab/ShahabEngineUnified.ts` | `IDEMPOTENT_SAFE` | YES | `MEDIUM_PARTIAL_PROGRESS` |
| 8 | Persian Context Memory & False-Insertion Guard (`B08_CONTEXTUAL_VOCABULARY`) | `src/shahab/ShahabPersianMemoryAndContext.ts`, `src/asr-core/PersianEvidenceCorrectionEngine.ts`, `src/asr-core/PersianLexicalDisambiguationEngine.ts` | `IDEMPOTENT_SAFE` | NO | `NONE` |
| 9 | Frame-to-Word Alignment & Timestamp Generation (`B09_ALIGNMENT_TIMESTAMPS`) | `src/shahab/ShahabEngineUnified.ts` | `IDEMPOTENT_SAFE` | NO | `NONE` |
| 10 | Four-Layer Transcript Assembly & P0-009 Normalization (`B10_TRANSCRIPT_ASSEMBLY`) | `src/shahab/ShahabEngineUnified.ts`, `src/asr-core/PersianLinguisticQualityEngine.ts` | `IDEMPOTENT_SAFE` | YES | `MEDIUM_PARTIAL_PROGRESS` |
| 11 | Avapardaz Editing Timeline Bridge (`B11_AVAPARDAZ_EDITING_INTEGRATION`) | `src/shahab/ShahabEngineUnified.ts`, `src/runtime/CrashRecoveryAndSessionLock.ts` | `BOUNDED_WITH_IDEMPOTENCY_KEY` | NO | `HIGH_IF_NON_ATOMIC` |
| 12 | Atomic Persistence & Operational Export (`B12_PERSISTENCE_AND_EXPORT`) | `src/shahab/ShahabEvidenceStore.ts`, `src/shahab/ShahabResilienceEngine.ts` | `IDEMPOTENT_SAFE` | NO | `NONE` |

## Graceful Degradation Catalog
| Mode | Activation | Impact | Equivalent to Normal? | Recovery Condition |
|---|---|---|---|---|
| `CONTEXTUAL_BIASING_DISABLED` | Contextual vocabulary subsystem or P0-010/P0-012 hook throws or fails compatibility check. | Domain terminology biasing skipped; raw acoustic recognition preserved verbatim. | NO | Contextual memory & tokens.txt verified healthy on next job. |
| `FEATURE_CACHE_BYPASSED` | Memory pressure or cache integrity mismatch detected. | Higher latency (features/encoder recomputed); acoustic output identical. | YES | Process RSS returns below soft threshold and cache reinitializes cleanly. |
| `CONCURRENCY_REDUCED` | Process memory pressure or CPU exhaustion. | New jobs queued sequentially (max 1 active inference). | YES | Active RSS and queue pressure normalize. |
| `NEW_JOBS_PAUSED_STORAGE` | Measured available disk space falls below manifest requirement + safety margin. | New processing jobs paused; existing committed transcripts remain readable. | NO | Measured available disk space exceeds threshold. |
| `PARTIAL_TRANSCRIPT_PRESERVED` | Inference interrupted or cancelled after >= 1 chunk committed durably. | Only completed chunks available; explicitly tagged PARTIAL (never COMPLETED). | NO | Full job recovery completes remaining chunks and commits atomically. |
