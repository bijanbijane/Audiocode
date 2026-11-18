# Model Streaming Compatibility & Cumulative Overhead (Phase 5)

| Backend ID | Execution Mode | Native Incremental | Word Timestamps in Stream | Cumulative Audio Math (`30s`, `C=2.0s`) | Local G0 Status |
|---|---|---|---|---|---|
| `AVAPARDAZ_LOCAL_CTC_STREAMING` | `native_incremental_streaming` | Yes | `LOCAL_CTC_FRAME_BOUNDS` | `30.0s` (linear `1.0x`) | `EXECUTABLE_IN_G0_CPU` |
| `VAD_SEGMENTED_BATCH_FALLBACK` | `vad_segmented_streaming` | **No** (Explicitly disclosed in UI) | `UTTERANCE_SAMPLE_BOUNDS_ONLY` | `30.0s` (linear `1.0x`) | `EXECUTABLE_IN_G0_CPU` |
| `QWEN_OFFICIAL_STREAMING` | `native_incremental_streaming` | Yes (stateful chunks) | `NONE_IN_STREAMING` | `C * N * (N+1) / 2 = 240.0s` (`8.0x`) | `REQUIRES_EXTERNAL_VLLM_GPU_WORKER` |
| `VLLM_REALTIME_PROTOCOL` | `native_incremental_streaming` | Yes (WS delta/done) | `UTTERANCE_SAMPLE_BOUNDS_ONLY` | Streaming buffer | `REQUIRES_EXTERNAL_VLLM_GPU_WORKER` |

## Streaming Binary Protocol (`ASR-STREAM-PROTOCOL-V1`)
- **Header:** Exact 24-byte Big-Endian `ASR1` magic, protocol version `1`, message type, flags, sequence number, sample count (`1600` for 100ms), timestamp ms, CRC32/hash check.
- **Payload:** PCM16 Little-Endian (`[-32768, 32767]`), `16,000 Hz`, `Mono` -> `3,224 bytes` per 100ms packet.
- **VAD Hysteresis:** `512 samples` (32ms window), speech start `0.50`, continue `0.35`, `150ms` pre/post-roll, `600ms` endpointing, `12.0s` soft boundary, `30.0s` hard boundary (`forced_boundary=true`).
- **Known Limitations:** `VLLM_REALTIME_PROTOCOL` & `QWEN_OFFICIAL_STREAMING` remain offline until GPU vLLM worker URL is provisioned; browser `AudioWorklet` runs real-time capture off the main thread (`public/asr-stream-worklet.js`).
