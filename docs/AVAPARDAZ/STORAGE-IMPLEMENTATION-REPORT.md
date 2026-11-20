# AVAPARDAZ — OPFS & BOUNDED STORAGE IMPLEMENTATION REPORT (`AVP-P01-003`)

**Document ID:** `AVP-P01-STOR-001`  
**Phase:** `PHASE-01` — Local Runtime Foundation & Memory-Safe Audio Pipeline (`MASTER v3.1`)  
**Date:** `2026-11-20`  
**Status:** `VERIFIED`

---

## 1. Storage Architecture & Separation of Concerns

| Storage Layer | File(s) | Responsibility | Cap / Guarantee |
| :--- | :--- | :--- | :--- |
| **OPFS Sync Block Store** | `src/workers/ioBroker.worker.ts`, `src/engine/storageBroker.ts` | Persistent 4-second raw audio PCM blocks + seek tables + manifest verification | Runs exclusively inside dedicated Worker; Transferable `ArrayBuffer` transfers |
| **Bounded Main-Thread LRU Cache** | `src/engine/lruCache.ts` (`RollingLruBlockCache`) | Hot playback/editing PCM window cache | Strictly capped at `AVAPARDAZ_AUDIO_CACHE_SPLIT.mainThreadBytes` (`24 MiB`), auto-evicted on `MemoryBudgetManager` emergency |
| **Bounded OPFS-Unavailable Fallback** | `src/engine/storageBroker.ts` (`MAX_OPFS_UNAVAILABLE_FALLBACK_BYTES`) | Safe degraded mode when OPFS is absent (e.g., private browsing / unsupported host) | Hard-capped at **`32 MiB`** (`33,554,432 B`); never silently grows unbounded in RAM; UI never claims ready OPFS persistence |
| **Quota & Pool Accounting** | `src/engine/storageBroker.ts` (`estimateStorageQuotaForIngest`) | Pre-ingest storage check separating `'audio-blocks'` vs `'model-weights'` pools with safety headroom | Returns `sufficient: null` honestly when `navigator.storage.estimate()` is unavailable (zero fabricated disk space claims) |

---

## 2. Key Phase-01 Changes

1. **Exported `MAX_OPFS_UNAVAILABLE_FALLBACK_BYTES` (`32 MiB`)** in `src/engine/storageBroker.ts` to formalize and enforce the non-OPFS memory cap.
2. **Added `estimateStorageQuotaForIngest()`** in `src/engine/storageBroker.ts`:
   - Distinguishes storage pools (`audio-blocks` vs `model-weights`) so future Phase-02/05 model weights never silently collide with active audio scratch blocks.
   - Applies explicit safety margin when `navigator.storage.estimate()` reports `quota` and `usage`.
   - Returns `{ available: false, sufficient: null, ... }` when the browser environment does not expose `navigator.storage.estimate()`.
3. **Wired `streamReadRange` into Playback (`src/App.tsx` + `src/engine/audioPlayback.ts`):**
   - `App.tsx` passes `brokerRef.current.streamReadRange` into `playTimelineWindowed`, allowing OPFS-backed assets (`storageLifecycle === 'ready'`) to play without holding full-file PCM arrays in React state.

---

## 3. Verification Evidence (`[TESTED]`)

- `src/engine/storageBroker.test.ts`: **PASS** (atomic transaction commit/abort, manifest validation, SHA-256 verification, corrupted/partial block cleanup).
- `src/engine/streamingIngest.memory.test.ts`: **PASS** (bounded ingest RAM, OPFS-unavailable fallback honesty, `MemoryPressureError` rejection).
- `src/engine/streamingPlaybackExport.test.ts`: **PASS** (`estimateStorageQuotaForIngest` for both `audio-blocks` and `model-weights` pools, unavailable storage API honesty, block-backed playback reads).
- `src/studio/AudioImportCoordinator.test.ts`: **PASS** (`20/20` tests including OPFS ready vs memory-only fallback, manifest tampering rejection, atomic lease replacement, mid-ingest abort with `0` leaked bytes).
