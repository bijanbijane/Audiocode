# SHAHAB-021 System Qualification Plan & Immutable Configuration

- **Qualification Run ID:** `qual_20261121190723_c51f`
- **Config Digest SHA-256:** `f75ecc87d351d8a9187d1cedf3ecec4efda6b48c803b386174de9e13e5c58730`
- **Engine / Model:** SHAHAB-R2.0.0-RELEASE-CANDIDATE / INHERITED-PERSIAN-ASR-CORE (persian-zipformer-transducer)@0408facbcf3f670121def48e0802c395c225d150
- **Runtime / Provider:** onnxruntime-web@1.31.1 (wasm)
- **Streaming Mode:** INCREMENTAL_WINDOWED_INFERENCE (window=2.0s, step=1.0s; TRUE_STATEFUL_STREAMING=NOT_SUPPORTED_BY_MODEL)

## Independent Entry-Gate Audit (SHAHAB-013 through SHAHAB-020)

| Mission | Source | State | Remaining Blocker |
|---|---|---|---|
| SHAHAB-013 | `src/shahab/ShahabReleaseHardening.ts` | **PARTIALLY_VERIFIED** | Ed25519 release artifact signing infrastructure is BLOCKED (no managed signing key in workspace). |
| SHAHAB-014 | `src/shahab/ShahabOperationsGovernance.ts` | **PARTIALLY_VERIFIED** | Automatic production rollout disabled while cryptographic release signing remains BLOCKED. |
| SHAHAB-015 | `src/shahab/ShahabResilienceEngine.ts` | **VERIFIED** | Production SLIs remain INSUFFICIENT_EVIDENCE until real production fleet traffic exists. |
| SHAHAB-016 | `src/shahab/ShahabPerformanceEngine.ts` | **VERIFIED** | Benchmarked on Node WASM CPU only; WebGPU and Native C++ providers are unavailable. |
| SHAHAB-017 | `src/shahab/ShahabStreamingEngine.ts` | **VERIFIED** | TRUE_STATEFUL_STREAMING is NOT_SUPPORTED_BY_MODEL; runs verified INCREMENTAL_WINDOWED_INFERENCE. |
| SHAHAB-018 | `src/shahab/ShahabRuntimeConformance.ts` | **PARTIALLY_VERIFIED** | WebGPU/CUDA BLOCKED, Native C++ UNAVAILABLE, Browser Local WASM AVAILABLE_BUT_UNVERIFIED. |
| SHAHAB-019 | `src/shahab/ShahabPersianFidelity.ts` | **VERIFIED** | P0-011 not present in workspace; P0-009/P0-010/P0-012 reused without parallel correction engine. |
| SHAHAB-020 | `src/shahab/ShahabCompactModelResearch.ts` | **VERIFIED** | No <100 MiB uncompressed runtime model available; Variant A (110.41 MiB) retained and protected. |
