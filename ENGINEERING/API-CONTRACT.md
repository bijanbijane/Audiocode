# REST & WEBSOCKET API CONTRACT — PHASES 3, 4 & 5

**Document Version:** `1.0.0-phase3-4-5`  
**Server Implementation:** `/server.ts`

---

## 1. Phase 3 Benchmarking & Error Intelligence Endpoints

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/api/v1/engines` | Lists all 13 registered ASR engines, capabilities, pricing models, and live environment availability. |
| `POST` | `/api/v1/experiments` | Creates and executes a controlled multi-engine benchmark experiment with `FA-STRICT-V1` / `FA-RELAXED-V1` / `EN-NORM-V1` / `MIXED-NORM-V1` and 36-node Error Taxonomy classification. |
| `POST` | `/api/v1/benchmark/compare` | Runs a 10,000-iteration Paired Bootstrap significance test + Holm-Bonferroni correction between two engines. |
| `GET` | `/api/v1/benchmark/leaderboards` | Returns verified Persian, Code-Switching, Noisy Audio, and Latency leaderboards. |

---

## 2. Phase 4 Independent ASR Model Endpoints

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/api/v1/asr/health` | Returns health status, active checkpoint (`ASR-FA-EN-1.0.0-RC1`), SHA-256 digest, and hardware profile (`G0_CPU_ONLY`). |
| `GET` | `/api/v1/asr/models` | Lists candidate models (`M01`..`M06`), 6-part license verification, and active checkpoint history. |
| `POST` | `/api/v1/asr/transcriptions` | Executes independent ASR transcription with strict 3-layer output separation (`raw_model_output`, `normalized_text`, `domain_adapted_text`) and configurable domain vocabulary profile. |
| `POST` | `/api/v1/asr/checkpoints/rollback` | Rolls back the active model checkpoint to any previous verified checkpoint ID. |

---

## 3. Phase 5 Real-Time Streaming Endpoints (`/api/v1/streaming/...`)

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/api/v1/streaming/sessions` | Creates a streaming session and issues a single-use short-lived token (`token_expires_in_seconds: 30`). |
| `GET` | `/api/v1/streaming/sessions/:id` | Retrieves session metadata, state machine history, and active mode disclosure. |
| `POST` | `/api/v1/streaming/sessions/:id/handshake` | Authenticates the single-use session token (`ASR-STREAM-PROTOCOL-V1`) and transitions `CREATED -> AUTHENTICATING -> READY`. |
| `POST` | `/api/v1/streaming/sessions/:id/audio-frame` | Ingests a 24-byte `ASR1` binary frame (or base64-encoded `ASR1` frame), validates sequence continuity, runs Silero-compatible VAD, and emits `audio.ack`, `speech.started`, `transcript.partial`, `speech.ended`, and `transcript.final` events. |
| `POST` | `/api/v1/streaming/sessions/:id/resume-token` | Issues a short-lived single-use resume token for connection recovery. |
| `POST` | `/api/v1/streaming/sessions/:id/finalize` | Transitions session `ENDING -> FINALIZING -> COMPLETED` idempotently. |
| `DELETE` | `/api/v1/streaming/sessions/:id` | Cancels session cleanly (`CANCELLED`) without claiming finalization completed. |
| `GET` | `/api/v1/streaming/sessions/:id/transcript` | Returns all partial and committed utterances with revision counts and sample coordinates. |
| `GET` | `/api/v1/streaming/sessions/:id/metrics` | Returns TTFP, VAD latency, Finalization latency percentiles (`P50/P90/P95/P99`), audio backlog, and Qwen cumulative reprocessing overhead. |
| `GET` | `/api/v1/streaming/engines` | Lists all 4 streaming backend tracks (`QWEN_OFFICIAL_STREAMING`, `VLLM_REALTIME_PROTOCOL`, `VAD_SEGMENTED_BATCH_FALLBACK`, `AVAPARDAZ_LOCAL_CTC_STREAMING`). |
| `GET` | `/api/v1/streaming/health` | Returns system-wide streaming gateway observability and concurrency admission capacity. |
