# PHASE 10 — PRODUCT CAPABILITY MATRIX

| Product / Model | Public Contract | Maturity Stage | Languages | Execution Modes | Timestamps | Diarization | Container Status (`G0_CPU_ONLY`) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **PRODUCT-A: Batch STT API** | `POST /v1/audio/transcriptions` | `PRIVATE_ALPHA` | `fa`, `en`, `fa-en` | `batch` | Supported (`asr-fa-en-v1`) | Supported (`asr-fa-en-v1`) | **AVAILABLE_NOW** (Local CPU Engine) |
| **PRODUCT-B: Real-Time Streaming** | `POST /v1/audio/streaming-sessions` + `ASR1` | `PRIVATE_ALPHA` | `fa`, `en`, `fa-en` | `native_streaming` | Frame-level | Partial / Active | **AVAILABLE_NOW** (`AVAPARDAZ_LOCAL_CTC_STREAMING`) |
| **PRODUCT-C: Long-Form Async** | `POST /v1/audio/transcriptions` (`execution_mode=long_form_async`) | `PRIVATE_ALPHA` | `fa`, `en`, `fa-en` | `long_form_async` | Supported | Supported | **AVAILABLE_NOW** (Async Job State Machine) |
| **PRODUCT-D: Enterprise & Regions** | RBAC + Audit Logs + Data Residency Guard | `PRIVATE_ALPHA` | N/A | Policy Control | N/A | N/A | **AVAILABLE_NOW** (Single-Region `ir-thr-01`) |
| `qwen3-asr-1.7b-fa` | `/v1/models/qwen3-asr-1.7b-fa` | `PREVIEW` | `fa`, `en` | `batch`, `native_streaming` | **Unsupported** | **Unsupported** | **BLOCKED — REQUIRES_GPU_WORKER** (`503`) |
| `whisper-large-v3-fa` | `/v1/models/whisper-large-v3-fa` | `BETA` | `fa`, `en` | `batch`, `vad_segmented_streaming` | Supported | **Unsupported** | **BLOCKED — REQUIRES_GPU_WORKER** (`503`) |
| Region `eu-central-01` | Multi-Region Staging | `PRIVATE_ALPHA` | N/A | Regional Processing | N/A | N/A | **STAGED_NOT_OPERATIONAL** |
