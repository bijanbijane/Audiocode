# AVAPARDAZ — PHASE-08: CPU PERFORMANCE, MEMORY & LONG-AUDIO BENCHMARKS

**Document ID:** `AVP-P08-BENCH-1.0`  
**Date:** `2026-11-20`  
**Host Profile:** Linux `x86_64`, `4` vCPUs, `12 GiB` RAM (`G0_CPU_ONLY`, Zero GPU, Strict Offline Environment)

---

## 1. Real Neural CPU Inference Benchmarks (`25 / 25` Real FLEURS Audio, `277.33s` Total)

| Model | Threads | Cold Start | Single-Stream Peak RSS | Decode Time (`277.33s` audio) | **Overall RTF** | Speed Multiplier | Offline Verified |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`Reza2kn/Shenava-Rizeh` (INT8)** | `4` | `2,128 ms` | **`165.81 MiB`** | `9.98 s` | **`0.0360`** | **`27.8×` real-time** | `TRUE` |
| **`openai/whisper-base-int8`** *(Rejected)* | `4` | `1,882 ms` | `326.68 MiB` | `64.17 s` | `0.2314` | `4.32×` real-time | `TRUE` |
| **`openai/whisper-base-fp32`** | `4` | `2,732 ms` | `526.31 MiB` | `65.78 s` | `0.2372` | `4.22×` real-time | `TRUE` |
| **`openai/whisper-large-v3-turbo-int8`** | `4` | `7,519 ms` | `1,382.88 MiB` | `169.75 s` | **`0.6121`** | **`1.63×` real-time** | `TRUE` |
| **`Qwen/Qwen3-ASR-0.6B-int8`** *(Rejected)* | `4` | `11,612 ms` | `1,588.21 MiB` | `276.50 s` | `0.9970` | `1.00×` real-time | `TRUE` |

*Projected 60-minute audio CPU processing time on equivalent 4-core CPU (linear extrapolation from measured steady-state RTF):*
- **`Shenava-Rizeh INT8` (Persian):** `~2.2 minutes` (`RTF 0.036`) with `~166 MiB` Peak RSS.
- **`Whisper large-v3-turbo INT8` (EN/Multilingual):** `~36.7 minutes` (`RTF 0.612`) with `~1.38 GiB` Peak RSS.

---

## 2. Live End-to-End Companion IPC Benchmark (`[TESTED]`)

- **Test Case:** `LocalCompanionAndSecurity.test.ts` Test #6 (Loopback HTTP + HMAC-SHA256 Handshake + Nonce + `LocalSherpaNeuralEngine` + `Reza2kn/Shenava-Rizeh INT8` on real `9.48s` Persian FLEURS audio `fleurs-fa-dev-01.wav`).
- **Observed End-to-End Wall Time (incl. HTTP IPC, ffmpeg PCM16 ingestion, model load, neural decode, JSON serialization):** **`3.90 seconds`** (`~2.43×` faster than real-time even including cold process startup!).
- **Output Verified:** Authentic Persian text (`"بیشتر دوران زندگی این خانواده یهودی در فضای باز گذشت"`) + genuine `WORD`-level timestamps.

---

## 3. Bounded Memory Stress Test (`10s` -> `60 Minutes` Sliding-Window Pipeline, `[TESTED]`)

Executed via `LocalCompanionAndSecurity.test.ts` Test #3 (`runBoundedLongAudioPipeline` with RMS energy-valley boundary snapping & Persian overlap deduplication):

| Recording Duration | PCM16 Samples (`16 kHz`) | Pipeline Behavior | Measured RSS Delta | Status |
| :--- | :---: | :--- | :---: | :---: |
| `10 seconds` | `160,000` | Single window | Flat `O(1)` | `PASS` |
| `1 minute` (`60s`) | `960,000` | Multi-window + overlap dedup | Flat `O(1)` | `PASS` |
| `10 minutes` (`600s`) | `9,600,000` | Sliding window + energy-valley snap | Flat `O(1)` | `PASS` |
| `30 minutes` (`1,800s`) | `28,800,000` | Sliding window + energy-valley snap | Flat `O(1)` | `PASS` |
| **`60 minutes` (`3,600s`)** | **`57,600,000`** | Sliding window + energy-valley snap | **`< 128 MiB` delta (`365.8 ms` pipeline overhead)** | **`PASS`** |

*(Combined with Phase-01 `src/engine/longFileStress.test.ts` proving `30m/60m/120m` OPFS audio ingestion & streaming WAV export with `0 B` leaked and `<= 23.93 MiB` LRU cache.)*
