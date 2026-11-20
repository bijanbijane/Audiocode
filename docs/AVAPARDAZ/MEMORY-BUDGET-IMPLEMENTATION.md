# AVAPARDAZ — MEMORY BUDGET IMPLEMENTATION REPORT (`AVP-P01-002`)

**Document ID:** `AVP-P01-MEM-001`  
**Phase:** `PHASE-01` — Local Runtime Foundation & Memory-Safe Audio Pipeline (`MASTER v3.1`)  
**Date:** `2026-11-20`  
**Status:** `VERIFIED`

---

## 1. Policy & Architectural Thresholds (`src/runtime/memory/MemoryPolicy.ts`)

| Policy Parameter | Exact Value | Purpose |
| :--- | :---: | :--- |
| `hardLimitBytes` | `1,073,741,824 B` (`1,024 MiB`) | Absolute accounted memory hard ceiling; admission rejected with `MemoryPressureError` |
| `emergencyBytes` | `996,147,200 B` (`950 MiB`) | `EMERGENCY` pressure: triggers registered cache eviction callbacks before admission check |
| `throttleBytes` | `943,718,400 B` (`900 MiB`) | `THROTTLE` pressure: pauses non-critical background jobs |
| `targetBytes` | `891,289,600 B` (`850 MiB`) | `WARNING` (`HIGH`) operating ceiling |
| `audioCacheBytes` | `33,554,432 B` (`32 MiB`) | Combined audio cache ceiling (`24 MiB` Main Thread + `8 MiB` Worker split in `AVAPARDAZ_AUDIO_CACHE_SPLIT`) |

---

## 2. Implementation Summary (`src/runtime/memory/MemoryBudgetManager.ts`)

`MemoryBudgetManager` was preserved and hardened without breaking existing callers:

- **Typed Allocation Tracking:** Every `reserve()` validates positive safe integer `bytes`, non-empty `owner`, valid `MemoryCategory` (`decoded-audio`, `audio-cache`, `peak-pyramid`, `render-scratch`, `export-buffer`, `onnx-runtime`, `model-weights`, `worker-transfer`, `ui-transcript`, `other`), and returns a trackable `MemoryReservation`.
- **Duplicate ID Guard (`MT-07`):** Added optional caller-supplied `id?: string` on `MemoryReservationRequest` and exported `DuplicateMemoryAllocationIdError` to reject duplicate active allocation IDs cleanly without inflating totals.
- **Double-Release Protection (`MT-05`):** Releasing an already-released reservation is strictly idempotent and returns `false` without underflowing `accountedBytes` or category totals.
- **Owner-Scoped Bulk Cleanup (`MT-12`):** Added `releaseByOwner(owner: string): number` to atomically release all active reservations belonging to a cancelled job, terminated worker, or replaced project lease.
- **Deterministic Leak Detection (`MT-14`):** Added injectable clock `now?: () => number`, `getUsedBytes()`, `getCategoryUsage(category)`, `getActiveAllocations()`, and `detectLeaks(maxAgeMs, nowMs)` for deterministic aging/leak audits.
- **Emergency Eviction Loop (`MT-09`..`MT-11`):** On `EMERGENCY` (`>= 950 MiB`) or hard-limit breach (`> 1,024 MiB`), registered eviction callbacks (including `RollingLruBlockCache` eviction) execute synchronously before admission fails closed with `MemoryPressureError`.

---

## 3. Honest Telemetry Boundaries (`[OBSERVED]`)

- **Accounted Working Set (`MemoryBudgetManager.getUsedBytes()`):** Deterministic across Node.js, Workers, and all browsers.
- **Node.js Process RSS (`process.memoryUsage().rss`):** Directly observable in Node/Native environments and recorded in `LONG-FILE-STRESS-REPORT.md`.
- **Browser Process RSS:** **Not readable from ordinary browser JavaScript** (`performance.memory` is Chromium JS-heap only and excludes WASM linear memory, AudioBuffers, and Worker heaps). `CrossPlatformResourcePolicy.ts` explicitly reports unavailable OS/browser RAM telemetry as `'UNKNOWN'` rather than fabricating values.

---

## 4. Verification Evidence (`[TESTED]`)

- **Command:** `npx --yes tsx --test src/runtime/memory/MemoryBudgetManager.test.ts`
- **Result:** All `MT-01`..`MT-14` deterministic unit tests **PASS** (`0` failures), including allocation/release accounting, hard-limit rejection, duplicate ID rejection (`DuplicateMemoryAllocationIdError`), double-release safety, `THROTTLE`/`EMERGENCY` pressure transitions, LRU eviction hook recovery, `releaseByOwner()`, category usage accounting, and `detectLeaks()`.
