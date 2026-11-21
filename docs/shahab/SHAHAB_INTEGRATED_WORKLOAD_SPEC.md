# SHAHAB-021 Integrated End-to-End Workloads (WL-A through WL-H)

| ID | Workload | Qualification Label | Wall Time | RTF | Result | Quality Summary |
|---|---|---|---:|---:|---|---|
| WL-A | Short Conversational Persian Audio | REAL_AUDIO_END_TO_END | 956.48 ms | 0.0789 | **PASS** | Track A WER=0.384615, Track B WER=0.384615, text="شکلات داغ در حد ساندارهای بلژیکی از آبیگاه گران قیمت ولی آنین باشند" |
| WL-B | Long Recording Processing & Cancellation | LONG_DURATION_AND_CANCEL | 1743.24 ms | 0.0719 | **PASS** | Decoded 58 BPE tokens cleanly without truncation. |
| WL-C | Live Speech Incremental Windowed Pipeline | INCREMENTAL_WINDOWED_ONLY | 3243.75 ms | 0.2676 | **PASS** | Revisions=13, firstPartial=136.321ms, final="شکلات داغ در حد ساندارهای بلژیکی از آبیگاه گران قیمت ولی آنین باشند" |
| WL-D | Difficult Colloquial Persian & Verbatim Distinction | LINGUISTIC_CONTRACT_VERIFICATION | 0.3 ms | N/A | **PASS** | Repetition preservation=100%, raw!=normalized preserved separately. |
| WL-E | Mixed-Language & Contextual Biasing False-Insertion Audit | CONTEXT_BIAS_AND_GUARD | 1352.84 ms | 0.1116 | **PASS** | Verified=2 (unverified excluded), falseInsertionRate=0, action=KEEP_BIAS_ENABLED |
| WL-F | Resource-Constrained & Queue Saturation Resilience | DEGRADATION_AND_BACKPRESSURE | 0.03 ms | N/A | **PASS** | Backpressure explicitly signaled=true; zero silent drops. |
| WL-G | Interrupted Execution, Checkpoint Verification & Restore Drill | CRASH_RECOVERY_QUALIFIED | 0 ms | N/A | **PASS** | Authorized final transcripts never overwritten by partial recovery. |
| WL-H | Runtime & Provider Capability Negotiation | SUPPORTED_PROVIDERS_ONLY | 3.16 ms | N/A | **PASS** | UnauthorizedCloud=BLOCKED_CLOUD_AUTHORIZATION_REQUIRED; WebGPU_AUTO=SELECTED_LOCAL_WASM (explicit fallback=true). |
