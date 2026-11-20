# AVAPARDAZ — PHASE-08: LOCAL CPU RUNTIME ARCHITECTURE & ENGINEERING DECISIONS

**Document ID:** `AVP-P08-RUNTIME-1.0`  
**Date:** `2026-11-20`  
**Status:** `IMPLEMENTED AND VERIFIED (LINUX CPU CONTAINER)`

---

## 1. Runtime Selection Decision (`sherpa-onnx` + `onnxruntime-web`)

| Runtime Layer | Chosen Engine | License | Why Chosen | Alternatives Deferred / Rejected |
| :--- | :--- | :---: | :--- | :--- |
| **Native CPU Companion (`P1` & Local `P2`)** | **`sherpa-onnx` (`v2.0.2`)** (`LocalSherpaNeuralEngine.ts`) | `Apache-2.0` | One single C++/ONNX binary executes **NeMo FastConformer CTC**, **OpenAI Whisper**, and **Qwen3-ASR** natively on CPU with zero Python/PyTorch/GPU dependencies. | `faster-whisper` (Python + CTranslate2 overhead), `Vosk` (monolingual Kaldi FST, fails EN/code-switch). |
| **Browser Standalone Fallback (`P2`)** | **`onnxruntime-web` (`^1.31.1`)** | `MIT` | Installed locally (`node_modules/onnxruntime-web/dist/*.wasm`); supports WASM SIMD + optional pthreads; fits `36.4 MiB` `Shenava-Rizeh` INT8 well inside `384–1,024 MiB` browser budget. | Cloud API fallback (`PROHIBITED` by `ADR-015`/`ADR-019`). |
| **Audio Canonicalization** | **`CoreAudioIngestion.ts` + `ffmpeg` / Kaiser-Sinc Resampler** | Permissive / MIT | Guarantees `16 kHz Mono PCM16` with stereo phase-cancellation protection before neural inference. | Passing raw multi-channel 48kHz buffers directly into ASR models. |

---

## 2. Production CPU Memory, Threading & Streaming Engineering

### A. Single-Model Memory Guard & Lazy Loading (`LocalSherpaNeuralEngine.ts`)
- **Single-model resident policy:** Never loads multiple multi-hundred-MB neural models simultaneously.
- **Explicit `MODEL_UNLOAD` capability:** Exposed over Companion IPC (`CAPABILITY_EXECUTE` -> `MODEL_UNLOAD`) so Adobe Audition / Web users can immediately reclaim host RAM.
- **Process isolation & real cancellation:** Runs `sherpa-onnx-offline` as a managed child process with `AbortSignal` -> immediate `SIGKILL` + `finally` cleanup of temporary WAV chunks under `os.tmpdir()/avapardaz-ingest-*`.
- **Byte-Level UTF-8 BPE Resilience:** Real Whisper Turbo benchmarking uncovered that `sherpa-onnx-offline` emits individual split multi-byte UTF-8 BPE bytes (`0xd8` etc.) inside `"tokens": [...]` on Persian/bilingual audio; both Python (`encoding='utf-8', errors='replace'`) and Node.js (`Buffer.toString('utf8')`) handle this cleanly without crashing.

### B. `O(1)` Bounded Sliding-Window Long-Audio Pipeline (`LongAudioChunkedPipeline.ts`)
- **Problem solved:** Full-file neural inference on 30–120 minute recordings spikes RAM and violates Whisper's 30s receptive window.
- **Design:**
  1. Streams audio in fixed `chunkSeconds` windows (default `25s`–`30s`) with configurable `overlapSeconds` (default `2s`).
  2. Snaps chunk cut boundaries to the lowest-RMS **energy valley** inside a search margin so words are not sliced mid-syllable.
  3. Reconciles cross-chunk seams via `deduplicateChunkOverlap()` using Persian ZWNJ & Arabic `ي`/`ك` normalization so duplicated seam words are stripped without altering legitimate Persian text.
  4. Verified via `LocalCompanionAndSecurity.test.ts` Test #3 across **10s, 1 min, 10 min, 30 min, and 60 min (`3,600s`)** recordings with `O(1)` flat memory (`rssDeltaMb < 128 MiB`) and instant `AbortSignal` mid-stream cancellation (Test #4).

### C. Strict Offline Environment Isolation
Every native inference invocation injects:
- `http_proxy=http://127.0.0.1:9`, `https_proxy=http://127.0.0.1:9`, `ALL_PROXY=http://127.0.0.1:9`
- `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`
Guaranteeing zero outbound DNS/HTTP egress during inference.

### D. Honest Timestamp Policy (Zero Fabrication)
- `Reza2kn/Shenava-Rizeh` (NeMo FastConformer CTC): emits genuine token/word timestamps -> tagged `timestampGranularity: "WORD"`.
- `Whisper` (`base` / `large-v3-turbo` via `sherpa-onnx-offline`): emits segment-level text without reliable native word timestamps -> tagged `timestampGranularity: "SEGMENT"` and `words: []` (never linearly interpolated or fabricated).
