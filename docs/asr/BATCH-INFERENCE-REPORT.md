# BATCH & LONG-FORM INFERENCE REPORT

**Milestones:** `CORE-02`, `CORE-05`, `CORE-07`  
**Verification Date (UTC):** `2026-11-18`  
**Implementation:** `/src/asr-core/CoreAudioIngestion.ts`, `/src/asr-core/CoreBatchAndLongFormEngine.ts`, `/src/asr-core/CoreAcousticCtcEngine.ts`  
**HTTP Endpoint:** `POST /api/v1/asr-core/batch`

---

## 1. Multi-Format FFmpeg Ingestion Verification (`CORE-02`)

Verified locally via live `/usr/bin/ffmpeg` + `ffprobe` execution in `src/asr-core/__tests__/coreAsrEngine.test.ts` (Test 1 & Test 2, **PASSED**):

| Container Format | Detected Format (`detectAudioContainerFormat`) | Canonical Output | Sample Rate | Channels | Verification Status |
| :--- | :---: | :---: | :---: | :---: | :---: |
| `.wav` (RIFF PCM) | `wav` | PCM16 Mono Float32 | `16,000 Hz` | `1` (downmixed after correlation inspect) | **PASS** |
| `.mp3` | `mp3` | PCM16 Mono Float32 | `16,000 Hz` | `1` | **PASS** |
| `.flac` | `flac` | PCM16 Mono Float32 | `16,000 Hz` | `1` | **PASS** |
| `.ogg` (Opus/Vorbis) | `ogg` | PCM16 Mono Float32 | `16,000 Hz` | `1` | **PASS** |
| `.m4a` (AAC) | `m4a` | PCM16 Mono Float32 | `16,000 Hz` | `1` | **PASS** |
| `.webm` (Opus) | `webm` | PCM16 Mono Float32 | `16,000 Hz` | `1` | **PASS** |

- **Anti-Phase & Silent-Channel Guard (`inspectAndDownmixChannels`):** Verified directly on anti-phase stereo (`L = -R`, Pearson correlation `-1.0`): naive `(L+R)/2` cancellation is **prevented**; engine raises explicit `ANTI_PHASE_STEREO_DETECTED` warning and selects the dominant non-canceling channel so SNR is preserved.

---

## 2. Long-Form Boundary Segmentation, Overlap Stitching & Failure Recovery (`CORE-05`)

- **Energy-Valley Snapping (`findBestBoundaryValleySample`):** Searches around nominal segment cutpoints for minimum RMS energy valleys to prevent mid-word slicing.
- **Overlap Phrase Deduplication (`stitchSegmentsWithOverlapDeduplication`):** Merges overlapping context windows without duplicating boundary tokens while advancing canonical sample offsets.
- **45-Second Multi-Segment Stress Profile (`buildLongFormStressAudioPcm(45)`):**
  - **Audio Duration:** `45.00 s` (`720,000` samples @ `16 kHz`)
  - **Segment Config:** `maxSegmentDurationSec = 12s`, `contextOverlapSec = 1.0s`, `maxRetriesPerSegment = 1`
  - **Observed Segment Boundaries:**
    - Seg 0: `0.00s -> 10.81s` (`122` chars)
    - Seg 1: `9.81s -> 21.11s` (`134` chars)
    - Seg 2: `20.11s -> 31.91s` (`158` chars)
    - Seg 3: `30.91s -> 42.71s` (`158` chars)
    - Seg 4: `41.71s -> 45.00s` (`16` chars)
  - **Status:** `COMPLETED` (`0` failed segments)
  - **Observed Peak RSS Memory:** **`104.63 MB`** (`well within 12 GiB container budget`)
- **Explicit Injected Segment Failure Test (`coreAsrEngine.test.ts` Test 3):**
  - Injecting persistent error on `segmentIndex = 1` correctly retries up to `maxRetriesPerSegment`, transitions status from `COMPLETED` to **`PARTIAL_WITH_FAILURES`**, preserves adjacent segments (`Seg 0`, `Seg 2`), and surfaces exact `[startSec, endSec]` in `failedSegmentRanges` rather than silently omitting audio.
