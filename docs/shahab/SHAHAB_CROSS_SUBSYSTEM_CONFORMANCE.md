# SHAHAB-021 Cross-Subsystem Interaction Conformance (5.1 – 5.6)

| Test ID | Interaction Pair | Result | Evidence Detail |
|---|---|---|---|
| XSUB-5.1 | Performance Optimizations (OPT-001/002) <-> Streaming Correctness | **PASS** | OPT-001 exact=true, OPT-002 exact=true, mergedRepWords=2. |
| XSUB-5.2 | Streaming Revisions <-> Transcript Editor & Undo History | **PASS** | LateFinalizeBlocked=true, DupIgnored=DUPLICATE_REVISION_IGNORED, DisplayTextPreserved=true. |
| XSUB-5.3 | Runtime Fallback <-> Transcript Provenance & Honesty | **PASS** | FallbackExplicit=true, ActualProvider=wasm, TrueStateful=NOT_SUPPORTED_BY_MODEL. |
| XSUB-5.4 | Contextual Biasing (SHAHAB-008) <-> Persian Fidelity (SHAHAB-019) | **PASS** | FalseInsertionRate=0, UnverifiedExcluded=true, RawAcousticPreserved=true. |
| XSUB-5.5 | Memory Cache Eviction <-> Crash Recovery Checkpoints | **PASS** | InMemoryCacheCleared=0B, DiskRecoveryAndRestoreVerified=true. |
| XSUB-5.6 | Model Package Footprint (SHAHAB-020) <-> Runtime Portability (SHAHAB-018) | **PASS** | Immutable=true, ONNXArtifacts=3, ActiveProtected=true. |
