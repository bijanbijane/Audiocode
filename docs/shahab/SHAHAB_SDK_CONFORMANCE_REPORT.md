# SHAHAB SDK Conformance Report (SHAHAB-022)

- **Passed:** 7/7
- **Sample Host Run:** 6s audio, RTF=0.0755, cancelVerified=true
- **SDK-LIFE-01 [ENGINE_LIFECYCLE]**: PASS — Idempotent initialization & verified immutable model identity (model=persian-zipformer-transducer-1.0.0, sha=0408facbcf3f, hashes=4)
- **SDK-COMPAT-01 [COMPATIBILITY]**: PASS — Capability negotiation discloses unsupported word timing/stateful streaming & rejects incompatible major version (limitations=2, badMajorRejected=true)
- **SDK-PRIV-01 [PRIVACY_SECURITY]**: PASS — Unauthorized Cloud transfer & out-of-workspace file paths are strictly rejected (cloudBlocked=true, pathEscapeBlocked=true)
- **SDK-JOB-01 [JOB_LIFECYCLE]**: PASS — Real Local transcription, idempotency replay/conflict, project isolation, and cancellation semantics (textLen=36, replayMatch=true, conflict=true, tenantIsolated=true, cancel=CANCELLATION_COMPLETED)
- **SDK-STREAM-01 [STREAMING]**: PASS — Incremental windowed streaming session, chunk acknowledgement, duplicate rejection & finalization (mode=INCREMENTAL_WINDOWED_INFERENCE, dupRejected=true, finalState=COMPLETED)
- **SDK-CONC-01 [CONCURRENCY]**: PASS — Concurrent multi-project jobs complete with distinct job/project identities (jobA=shjob_d074a8ab8771 (proj-A), jobB=shjob_83495185464b (proj-B))
- **SDK-LIFE-02 [ENGINE_LIFECYCLE]**: PASS — Idempotent disposal and strict rejection of calls after disposal (postDisposeRejected=true)
