# STREAMING INFERENCE REPORT

**Milestone:** `CORE-06`, `CORE-07`  
**Verification Date (UTC):** `2026-11-18`  
**Implementation:** `/src/asr-core/CoreStreamingAsrEngine.ts` (`CoreStreamingAsrManager`)  
**HTTP Simulation Endpoint:** `POST /api/v1/asr-core/stream-sim`

---

## 1. Execution Category Classification (Honest Architecture Disclosure)

- **Default CPU Streaming Category:** **`STATEFUL_CHUNKED_STREAMING`**
  - Chunks accumulate in bounded ring/sample buffers per active utterance, trigger VAD (`speech.started`), periodically emit hypothesis updates (`transcript.partial` / `transcript.revision`) across active chunks, commit on trailing silence or max-utterance cap (`transcript.final` + `speech.ended`), and close cleanly with `session.completed`.
- **Fallback / External Category Types Supported in Contract:**
  - `VAD_SEGMENTED_BATCH` (explicitly labeled when an external Python worker runs segment-level batching)
  - `NATIVE_INCREMENTAL_STREAMING` (reserved for stateful transducer/streaming-conformer ONNX graphs when mounted)

---

## 2. Live Chunk Packet Sweep (`100ms`, `250ms`, `500ms`, `1000ms` PCM16)

Measured on `CoreStreamingAsrManager` with `1.920 s` Persian multi-word 16kHz PCM16 audio (`'سلام امروز سرویس گفتار آماده'`):

| Chunk Size | Execution Category | Chunks Received | First Partial Latency (ms) | Finalization Latency (ms) | Total CPU Processing (ms) | Measured CPU RTF | Revisions | Emitted Events | Dropped Overload Chunks |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`100 ms`** | `STATEFUL_CHUNKED_STREAMING` | 20 | **4.17 ms** | 8.19 ms | 92.70 ms | **0.0483** | 1 | 22 | 0 |
| **`250 ms`** | `STATEFUL_CHUNKED_STREAMING` | 8 | **1.75 ms** | 8.77 ms | 53.00 ms | **0.0276** | 0 | 13 | 0 |
| **`500 ms`** | `STATEFUL_CHUNKED_STREAMING` | 4 | **3.18 ms** | 8.67 ms | 35.10 ms | **0.0183** | 0 | 9 | 0 |
| **`1000 ms`** | `STATEFUL_CHUNKED_STREAMING` | 2 | **6.83 ms** | 12.22 ms | 29.06 ms | **0.0151** | 0 | 7 | 0 |

- All emitted events carry strictly monotonic `seq` counters (`1..N`) and explicit `confidenceStatus: 'UNAVAILABLE_UNCALIBRATED'`.
- Real-time budget verification: `RTF <= 0.0483` across all packet sizes (`~20x–66x` faster than real-time on CPU for the Level A acoustic CTC decoder).

---

## 3. Concurrency, Backpressure & Overload Guard (`coreAsrEngine.test.ts` Test 4)

- **Session Concurrency Cap (`maxConcurrentSessions`):** Verified rejection with explicit `accepted: false` and `readyEvent.type === 'session.overloaded'` when capacity is saturated.
- **Queue Saturation Guard (`maxQueuedSamples`):** Oversized burst chunks emit `session.overloaded`, increment `droppedOverloadChunks`, and protect worker memory bounds rather than causing OOM.
