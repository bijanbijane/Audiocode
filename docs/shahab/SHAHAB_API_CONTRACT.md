# SHAHAB API Contract (v1.0.0)

- **Engine Lifecycle:** `createShahabSdkEngine`, `initialize`, `getEngineInfo`, `getCapabilities`, `getRuntimeInfo`, `getModelInfo`, `negotiateCapabilities`, `dispose`.
- **Job Lifecycle:** `submitTranscription`, `getJobStatus`, `subscribeToJobEvents`, `cancelJob`, `waitForFinalResult`, `getJobEvents`, `disposeJob`.
- **Streaming Lifecycle:** `createStreamingSession`, `appendAudioChunk`, `finalizeStreamingSession`, `cancelStreamingSession`, `disposeStreamingSession` (declares `INCREMENTAL_WINDOWED_INFERENCE`).
- **Idempotency:** Scoped by `tenantOrProjectId::idempotencyKey` with SHA-256 payload digest validation; mismatched payloads reject with `IDEMPOTENCY_CONFLICT`.
