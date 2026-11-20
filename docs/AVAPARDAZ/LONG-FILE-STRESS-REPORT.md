# AVAPARDAZ — LONG-FILE STREAMING STRESS REPORT (`AVP-P01-008`)

**Document ID:** `AVP-P01-STRESS-001`  
**Phase:** `PHASE-01` — Local Runtime Foundation & Memory-Safe Audio Pipeline (`MASTER v3.1`)  
**Date:** `2026-11-20`  
**Test Harness:** `src/engine/longFileStress.test.ts` (`npx --yes tsx --test src/engine/longFileStress.test.ts`)  
**Host Environment (`[OBSERVED]`):** Linux x86_64 container (`G0_CPU_ONLY`), 4 vCPUs, 12 GiB RAM, Node `v22.23.2`  
**Status:** `VERIFIED` (`6 / 6` scenarios PASS, `0` failures, `0 B` leaked)

---

## 1. Scientific Scope & Honesty Notice

- Synthetic deterministic 440 Hz trigonometric waveforms are used strictly to stress **memory admission, LRU cache eviction, streaming peak pyramid generation, chunked Kaiser-Sinc resampling, and streaming WAV export**.
- **Zero ASR recognition accuracy claims** are derived from synthetic audio (real speech accuracy benchmarking begins in `PHASE-02`).
- Node.js process RSS (`process.memoryUsage().rss`) is directly measured in this Node harness. Browser OS-level process RSS cannot be read from ordinary browser JavaScript and remains recorded as `UNKNOWN` in browser telemetry.

---

## 2. Exact Measured Results (`[TESTED]` — 2026-11-20)

All 6 scenarios ran 4-second chunks through `MemoryBudgetManager` (`1,024 MiB` hard ceiling), `RollingLruBlockCache` (`24 MiB` = `25,165,824 B` cap), `StreamingPeakPyramidBuilder`, `StreamingKaiserSincResampler` (`-> 16 kHz Mono`), and `StreamingWavExportEncoder` (`16 kHz Mono PCM16` sink):

| Scenario | Duration | Input Format | Blocks | Peak Accounted RAM (`MemoryBudgetManager`) | Peak Cache RAM (`RollingLruBlockCache`, cap 24 MiB) | Peak Node RSS (`process.memoryUsage().rss`) | Total Streamed Storage (Blocks + WAV) | Processing Time | Failures | Final Leaked Bytes |
| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `30m-16k-mono` | 30 min | `16000Hz Mono` | 450 | `512,000 B` (`0.49 MiB`) | `25,088,000 B` (`23.93 MiB`) | `230,445,056 B` (`219.77 MiB`) | `172,800,044 B` (`164.80 MiB`) | `2,076 ms` | `0` | `0 B` |
| `30m-48k-stereo` | 30 min | `48000Hz Stereo` | 450 | `1,792,000 B` (`1.71 MiB`) | `24,576,000 B` (`23.44 MiB`) | `339,062,784 B` (`323.35 MiB`) | `403,200,044 B` (`384.52 MiB`) | `11,723 ms` | `0` | `0 B` |
| `60m-16k-mono` | 60 min | `16000Hz Mono` | 900 | `512,000 B` (`0.49 MiB`) | `25,088,000 B` (`23.93 MiB`) | `341,921,792 B` (`326.08 MiB`) | `345,600,044 B` (`329.59 MiB`) | `3,115 ms` | `0` | `0 B` |
| `60m-48k-stereo` | 60 min | `48000Hz Stereo` | 900 | `1,792,000 B` (`1.71 MiB`) | `24,576,000 B` (`23.44 MiB`) | `389,619,712 B` (`371.57 MiB`) | `806,400,044 B` (`769.04 MiB`) | `22,607 ms` | `0` | `0 B` |
| `120m-16k-mono` | 120 min | `16000Hz Mono` | 1,800 | `512,000 B` (`0.49 MiB`) | `25,088,000 B` (`23.93 MiB`) | `370,692,096 B` (`353.52 MiB`) | `691,200,044 B` (`659.18 MiB`) | `6,405 ms` | `0` | `0 B` |
| `120m-48k-stereo` | 120 min | `48000Hz Stereo` | 1,800 | `1,792,000 B` (`1.71 MiB`) | `24,576,000 B` (`23.44 MiB`) | `531,980,288 B` (`507.34 MiB`) | `1,612,800,044 B` (`1.50 GiB`) | `48,524 ms` | `0` | `0 B` |

Total test duration: `94,983.6 ms` (`1/1` test passed, `0` failures).

---

## 3. Verified Invariants

1. **O(1) Accounted Working Set Scaling:** Moving from 30 min -> 60 min -> 120 min kept `peakAccountedMemoryBytes` strictly flat at `0.49 MiB` (`16kHz Mono`) and `1.71 MiB` (`48kHz Stereo`), proving zero full-file PCM retention.
2. **Strict LRU Eviction Cap:** Across 450 to 1,800 streamed blocks, `RollingLruBlockCache` peaked at `23.93 MiB` (`16kHz Mono`) and `23.44 MiB` (`48kHz Stereo`) — strictly below the `24.00 MiB` (`AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes`) ceiling.
3. **Zero Memory Leaks:** `finalLeakedBytes === 0` after every scenario (`MemoryBudgetManager.getSnapshot().accountedBytes === 0`).
4. **Exact Sample Continuity & WAV Header Integrity:** Every 120-minute export matched expected `16 kHz` output sample count within `<= 2` samples and exact WAV total byte count (`44 + total16kSamples * 2`).
5. **Headroom Margin:** Even for the 2-hour `48 kHz Stereo` case (`1.50 GiB` streamed storage), peak Node RSS remained `507.34 MiB` — well below the `850 MiB` warning threshold and `1,024 MiB` hard cap.
