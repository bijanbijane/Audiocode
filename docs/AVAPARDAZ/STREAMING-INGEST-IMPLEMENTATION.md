# AVAPARDAZ — STREAMING INGEST, RESAMPLING, PLAYBACK & EXPORT IMPLEMENTATION (`AVP-P01-004` / `AVP-P01-005`)

**Document ID:** `AVP-P01-INGEST-001`  
**Phase:** `PHASE-01` — Local Runtime Foundation & Memory-Safe Audio Pipeline (`MASTER v3.1`)  
**Date:** `2026-11-20`  
**Status:** `VERIFIED`

---

## 1. End-to-End Bounded Pipeline Overview

| Stage | Implementation | Memory Behavior | Honesty / Platform Scope |
| :--- | :--- | :--- | :--- |
| **WAV Streaming Ingest** | `src/engine/streamingIngest.ts` + `src/engine/storageBroker.ts` | True chunked `Blob.slice` parsing -> 4-second OPFS blocks + incremental `StreamingPeakPyramidBuilder` (`O(chunk)` RAM) | Verified for PCM16 / PCM24 / Float32 WAV up to multi-hour durations |
| **Compressed Browser Containers (MP3 / OGG / FLAC / M4A / WebM)** | `src/engine/streamingIngest.ts` | Container-aware `AudioContext.decodeAudioData()` guarded by explicit `MemoryBudgetManager` admission (`AVAPARDAZ_MEMORY_POLICY`) before decoding, then written to OPFS blocks and released | **Honest Limitation:** Browser Web Audio `decodeAudioData()` requires full container decode; never split compressed frames arbitrarily. True native streaming decode for compressed containers is scoped to `PHASE-03` Companion. |
| **App State PCM Retention Guard** | `src/App.tsx` (`handleFileUpload`) | `retainActivePcmMirror = file.size <= AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes` (`24 MiB`). Larger files store OPFS block manifests (`storageLifecycle === 'ready'`) with **zero full-file Float32Array in React state**. | Verified via `AudioImportCoordinator.test.ts` + live browser load |
| **Chunked Kaiser-Sinc Resampling (`-> 16 kHz Mono`)** | `src/engine/resampler.ts` (`StreamingKaiserSincResampler`, `resampleChunkedTo16kStream`) | Stateful Kaiser-windowed polyphase/sinc resampler carrying filter history across chunk boundaries (`O(chunk)` RAM) | Verified against single-pass reference at `48 kHz`, `44.1 kHz`, `32 kHz` |
| **Block-Backed Windowed Playback** | `src/engine/audioPlayback.ts` (`renderTimelineRangeFromBlocks`, `StudioAudioTransport.playTimelineWindowed`) | Reads only active playback windows via `brokerRef.current.streamReadRange()` (OPFS + bounded `RollingLruBlockCache`); session-token cancellation stops stale async pumps | Wired into all 3 `playTimelineWindowed` invocations in `src/App.tsx` |
| **Streaming WAV Export** | `src/engine/audioPlayback.ts` (`streamExportTimelineToWav`) + `src/processing-core/StreamingExportEncoder.ts` | Streams chunk-by-chunk through `StreamingWavExportEncoder` with `MemoryBudgetManager` reservations, `AbortSignal` cancellation, and target truncation/cleanup on failure/abort | Legacy `streamingChunkedRender()` additionally guarded by `MAX_LEGACY_FULL_RENDER_BYTES` (`128 MiB`) to block silent multi-hour OOM |

---

## 2. Resampler Numerical Equivalence Verification (`[TESTED]`)

Verified in `src/engine/resampler.test.ts` comparing single-pass `resampleMonoTo16k` against chunked streaming `resampleChunkedTo16kStream` across `48 kHz -> 16 kHz`, `44.1 kHz -> 16 kHz`, and `32 kHz -> 16 kHz`:

- **Sample count drift:** `<= 1 sample @ 16 kHz` (`PASS`)
- **RMS error (single-pass vs chunked streaming):** `< 1e-3` (`PASS`)
- **Max absolute error:** `< 5e-3` (`PASS`)
- **Chunk boundary continuity:** No clicks/discontinuities across arbitrary chunk sizes, stereo downmix, empty input, or single-sample edge cases (`PASS`)

---

## 3. Streaming Playback & Export Verification (`[TESTED]`)

Verified in `src/engine/streamingPlaybackExport.test.ts`:

- Block-backed rendering (`renderTimelineRangeFromBlocks`) with missing-block and storage-error rejection (`PASS`)
- Streaming WAV Export (`streamExportTimelineToWav`) for **PCM16 Mono** and **PCM24 Stereo** validated by both independent binary RIFF/WAVE header inspection and `ExportValidator.validateRenderedPcm()` (`PASS`)
- Corrupt WAV header rejection (`PASS`)
- Mid-export `AbortController` cancellation: aborts cleanly, truncates/cleans target sink, and leaves `0` leaked bytes in `MemoryBudgetManager` (`PASS`)
- Legacy full-file render guard rejects requests exceeding `MAX_LEGACY_FULL_RENDER_BYTES` (`128 MiB`) (`PASS`)
