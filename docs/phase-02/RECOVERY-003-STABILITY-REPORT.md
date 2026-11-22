# AVAPARDAZ — PHASE-02 RECOVERY-003..006 STABILITY & LONG-AUDIO REPORT

**Document ID:** `AVP-P02-REC003-STAB-001`  
**Execution Series:** `AVP-P02-RECOVERY-003` / `RECOVERY-004` / `RECOVERY-005` / `RECOVERY-006`  
**Date (UTC):** `2026-11-22`  
**Raw Evidence Files:**
- `evidence/phase02/recovery-003/03_stability_50_jobs.json` (`sha256: 080027f8342de5d213382dbe28625e90da2a7fe595ea4a7a737eb1fc18d63072`)
- `evidence/phase02/recovery-003/04_continuous_long_audio.json` (`sha256: cebfd5617bc754a3a8437dbc083bb8064e8e323a4946d83a39dad7b822559453`)

---

## 1. `EXP3` — 50 Consecutive Real Mixed Inference & Alignment Jobs (Offline)

Executed via `benchmarks/phase02/run_exp3_checkpointed.py` using `CheckpointCoordinator` (atomic per-job JSONL persistence) with every job isolated inside its own Linux kernel network namespace (`unshare -r -n`).

### 1.1 Aggregate Stability Results (`[Observed Fact]`)

- **`TOTAL_SUBMITTED_JOBS`:** `50`
- **`TOTAL_VALIDATED_JOBS`:** **`50 / 50`** (`100%`)
- **`PROCESS_CRASHES`:** **`0`**
- **`UNHANDLED_EXCEPTIONS`:** **`0`**
- **`CORRUPTED_RESULTS`:** **`0`**
- **Checkpoint State:** `COMPLETED` (`50` durable `OK` JSONL records)
- **`STATUS`:** **`PASS`**

### 1.2 Per-Provider Latency & Memory Profile (`EXP3`)

| Job Type | Count | All `rc == 0` | Decode P50 (s) | Decode P90 (s) | Decode Max (s) | Wall P50 (s) | Wall Max (s) | Peak RSS Min–Max (MiB) | Output Validation |
| --- | ---: | :---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `shenava_fa` | 25 | `true` | `0.332` | `0.410` | `0.440` | `2.119` | `2.424` | `149.20 – 203.83` (P50 `183.88`) | 25/25 non-empty FA text |
| `mfa_align_en` | 15 | `true` | `0.105` | `0.128` | `0.142` | `1.720` | `1.921` | `167.15 – 169.29` (P50 `168.35`) | 15/15 valid TextGrids (`validate_textgrid.py`) |
| `whisper_turbo_en` | 10 | `true` | `5.854` | `8.498` | `9.807` | `14.378` | `17.968` | `1,834.21 – 2,078.48` (P50 `1,934.34`) | 10/10 non-empty EN text |

> **Isolation Clarification:** `EXP3` validates fresh per-job service-lifecycle isolation (`unshare -r -n`). Sustained intra-process memory stability over continuous long audio is measured separately in `EXP4`.

---

## 2. `EXP4` — Genuine Unbroken 30.00-Minute Continuous Audio Pipeline (Offline)

Executed via `benchmarks/phase02/run_exp4_continuous_30m.py` inside Linux kernel network namespaces (`unshare -r -n`; live `/proc/11051/ns/net = net:[288]` verified on the running `sherpa-onnx-vad-with-offline-asr` process vs host `net:[2]`).

### 2.1 Source Audio Provenance & Integrity

- **Source File:** `/root/.avapardaz/datasets/librivox/bleak_house_03_16k.wav`
- **Provenance:** LibriVox *Bleak House* Section 3 (Charles Dickens) — **one genuine unbroken human recording** (`NOT` concatenated short clips)
- **License:** `CC0-1.0` (Public Domain)
- **Master Duration:** `3,563.337 s` (`59.39 min`)
- **File Size / Format:** `114,026,934 bytes`, `16,000 Hz`, `1` channel (Mono PCM16 WAV)
- **Master SHA-256:** `1d3e0bfc16aff05e0241fa1f7ae77592132d6a12a4c032c320a66d7b50cdef01`
- **Reference Transcript Available:** `false` *(execution, RTF, memory growth, and timeline continuity are verified; WER and human word-boundary accuracy are NOT claimed)*

### 2.2 Timeline Completeness (`EXPECTED_SOURCE_RANGE = [0.0, 1800.0)`)

| Window | Source Offset (s) | Duration (s) | Threads | `rc` | Decode (s) | Wall (s) | RTF | Peak RSS (MiB) | Steady-State 2nd-Half Drift (MiB) | VAD Segments | Emitted Words | Global Span (s) |
| :---: | :---: | ---: | :---: | :-: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `0` | `[0, 600)` | `600.0` | `4` | `0` | `370.017` | `380.214` | `0.6167` | `2,289.85` | **`0.00`** | `86` | `1,321` | `0.062 .. 589.676` |
| `1a` | `[600, 900)` | `300.0` | `3` | `0` | `207.563` | `215.109` | `0.6919` | `1,978.86` | `14.00` | `37` | `676` | `600.000 .. 897.228` |
| `1b` | `[900, 1200)` | `300.0` | `3` | `0` | `211.607` | `220.115` | `0.7054` | `2,000.32` | **`0.00`** | `46` | `587` | `900.158 .. 1192.268` |
| `2a` | `[1200, 1500)` | `300.0` | `3` | `0` | `231.553` | `240.139` | `0.7718` | `1,976.43` | `40.00` | `44` | `605` | `1201.054 .. 1496.044` |
| `2b` | `[1500, 1800)` | `300.0` | `3` | `0` | `205.420` | `215.108` | `0.6847` | `2,017.49` | `12.00` | `36` | `734` | `1501.470 .. 1792.012` |
| **Total** | **`[0, 1800)`** | **`1,800.0`** | — | **`5/5`** | **`1,226.160`** | **`1,270.685`** | **`0.6812`** | **`2,289.85`** | **`40.00` max** | **`249`** | **`3,923`** | **`0.062 .. 1792.012`** |

- **`missing_intervals`:** `[]` (`0` gaps)
- **`duplicate_intervals`:** `[]` (`0` double-counted intervals)
- **`coverage_verified_complete`:** `true`

### 2.3 Required `EXP4` Measurements (`AVP-P02-RECOVERY-006` Section 4.4)

| Metric Key | Verified Value |
| --- | --- |
| `SOURCE_DURATION_SECONDS` | `3563.337` |
| `PROCESSED_DURATION_SECONDS` | `1800.0` (`30.00 min`) |
| `WINDOW_COMPLETION_COUNT` | `5` (`0`, `1a`, `1b`, `2a`, `2b`) |
| `CHUNK_COMPLETION_COUNT` | `249` VAD speech chunks (`3,923` words) |
| `FAILED_WINDOW_COUNT` | `0` |
| `INFERENCE_SECONDS` | `1226.16` |
| `ALIGNMENT_SECONDS` | `1.016` (`15` sampled VAD segments, mean `align_rtf = 0.01206`; est. full 30m alignment `21.71 s`) |
| `TOTAL_PROCESSING_SECONDS` | `1272.632` (`preprocess = 0.931 s` + `wall = 1270.685 s` + `align_probe = 1.016 s`) |
| `RTF` | **`0.6812`** (`< 1.00` real-time gate **PASS**) |
| `PEAK_RSS_BYTES` | `2,401,081,754` (`2,289.85 MiB`) |
| `MEMORY_GROWTH_BYTES` | `41,943,040` (`40.00 MiB` max second-half steady-state drift; `0.00 MiB` on `win0` & `win1b`) |
| `POST_WARMUP_ARENA_RAMP_BYTES` | `696,736,809` (`664.46 MiB` initial ONNX Runtime arena high-water ramp-up in `win0`, flat thereafter) |
| `MISSING_WORD_COUNT` | `NOT_AVAILABLE` (no aligned gold transcript) |
| `DUPLICATE_WORD_COUNT` | `0` (`adjacent_boundary_same_word_count = 0`) |
| `TIMESTAMP_DISCONTINUITY_COUNT` | `0` (`segment_overlaps = 0`, `timestamp_discontinuities_gt_1s = 0`) |
| **`EXP4` STATUS** | **`PASS`** (Linux `x86_64` CPU; physical Apple M2 `8 GB` still `NOT_RUN`) |

---

## 3. Interruption-Resilient Checkpoint Infrastructure Validation

- **Implementation:** `benchmarks/phase02/checkpoint_coordinator.py` (atomic `tmp -> flush -> fsync -> os.replace`, durable fsynced JSONL journal with corrupted-tail recovery, strict `config_hash` + `model_artifact_hash` resume checks, `fcntl.flock` + PID lockfile, bounded retries).
- **Automated Verification (`benchmarks/phase02/test_checkpoint_coordinator.py`):** **`11 / 11 PASS`** including **6 fault-injection / simulated interruption tests** covering all 5 required interruption stages (inference, result serialization, atomic checkpoint writing, window completion, and experiment status update + stale lock recovery).
- **Combined Phase-02 Test Suite (`test_checkpoint_coordinator.py` + `test_evaluation_metrics.py` + `test_textgrid_validator.py`):** **`21 / 21 PASS` (`0.042 s`)**.
