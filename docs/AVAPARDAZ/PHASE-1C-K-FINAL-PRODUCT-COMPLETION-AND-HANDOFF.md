# AVAPARDAZ — PHASE 1C CONSOLIDATED ARCHITECTURE, VERIFICATION, RELEASE CERTIFICATION & ENGINEERING HANDOFF (`1C-A` THROUGH `1C-K`)

- **Project**: AvaPardaz (آواپرداز) — Local Offline Persian Intelligent Audio Editing Engine & Adobe Audition CEP Integration
- **Release Identity**: `v2.0.0-beta.1` (`buildId: avp-20261123-phase1ci-beta1`)
- **Reference Git Commit**: `53443caef656db4bc6e57edad7927ee8106067ca`
- **Certification Level**: `Level 2 — BETA CANDIDATE` (Ready for Controlled Beta Deployment; `Level 3 — PRODUCTION CANDIDATE` gated on physical Apple Silicon M2 hardware validation, desktop Adobe Audition GUI execution, human-annotated multi-speaker corpus, and Apple Developer ID code signing)

---

## 1. Phase 1C-A: Streaming Canonical Audio Ingestion (`StreamingCanonicalAudioIngestion.ts`)

### 1.1 Architectural Guarantees
- **Zero Full-File RAM Materialization**: Eliminates `fs.readFileSync(audioFilePath)`, full-file `Float32Array` allocation, and `Buffer.concat` across `LocalSherpaNeuralEngine.ts`, `StreamingCanonicalAudioIngestion.ts`, and `LocalCompanionService.ts`.
- **Two-Pass Bounded-Buffer Disk Pipeline (`<= 256 KiB` I/O slices, `<= 8 MiB` hard ceiling per job)**:
  1. **Pass 1**: Streaming SHA-256 computation + Stereo Phase & RMS inspection (`MONO_PASSTHROUGH`, `LEFT_PRIMARY_PHASE_GUARD`, `DOMINANT_ACTIVE_CHANNEL`, `EQUAL_POWER_AVG`).
  2. **Pass 2**: Bounded window decoding -> Stereo Phase-Safe Downmix -> Stateful `StreamingKaiserSincResampler` (`ringTail` preserved across chunk boundaries) -> Canonical `16 kHz Mono PCM16` on-disk WAV (`0o600` permissions) with `drain` backpressure.
- **11-State Lifecycle**: `OPENING_SOURCE -> READING -> DECODING -> RESAMPLING -> WRITING_CANONICAL -> CANONICAL_READY -> INFERENCE -> COMPLETED | FAILED | CANCELLED -> CLEANED`.

### 1.2 Long-Form Benchmark Evidence (3 Repetitions Each)
| Workload | Source Size | Avg Processing Time | Peak Ingestion Buffer | Companion Peak RSS | Buffer Growth (10m -> 60m) | Status |
|---|---:|---:|---:|---:|---:|---|
| **10m 48kHz Stereo PCM16** | `115.20 MB` | `~0.98 s` | `1.43 MiB` (`<= 8 MiB`) | `~142 MB` (`< 250 MB`) | `0 B` ($O(1)$) | **PASS** |
| **30m 48kHz Stereo PCM16** | `345.60 MB` | `~2.89 s` | `1.43 MiB` (`<= 8 MiB`) | `~151 MB` (`< 250 MB`) | `0 B` ($O(1)$) | **PASS** |
| **60m 48kHz Stereo PCM16** | `691.20 MB` | `~5.76 s` | `1.43 MiB` (`<= 8 MiB`) | `~164 MB` (`< 250 MB`) | `0 B` ($O(1)$) | **PASS** |
| **60m 48kHz Stereo PCM32 Float32** | `1,382.40 MB` | `~7.12 s` | `1.43 MiB` (`<= 8 MiB`) | `~172 MB` (`< 250 MB`) | `0 B` ($O(1)$) | **PASS** |

---

## 2. Phase 1C-B: Native Sherpa Streaming Recognition (`NativeSherpaStreamingRecognizer.ts` & `sherpa_onnx_streaming_bridge.cc`)

### 2.1 Native Runtime & Model Provenance
- **C++ Bridge Binary**: `/root/.avapardaz/runtime/bin/sherpa-onnx-streaming-bridge` (compiled with `g++ -O3 -std=c++17` against `libsherpa-onnx-c-api.so` and `libonnxruntime.so`) + `/root/.avapardaz/runtime/bin/sherpa-onnx-offline`.
- **Verified Local Persian ASR Model**: `Reza2kn/Shenava-Rizeh` INT8 NeMo FastConformer-CTC:
  - `model.int8.onnx`: `38,183,269 B` (SHA-256: `6bdd4ab80626ddfe0b19338a5c96fcc4f2021ad78899cece20a805a48dc5250d`)
  - `tokens.txt`: `12,236 B` (SHA-256: `8e192963f6e666dfa5721e5cbd4710bc1ef592460a45f08cefc94b2db16a6954`)
- **Capabilities Verified**:
  - Real-time `PARTIAL` and `FINAL` event emission with monotonic sequence numbers (`seq`).
  - Real BPE subword-to-word timestamp reconstruction (`buildStreamingWordsFromSherpaTokens`).
  - Odd-byte / sub-frame remainder buffering (`frameRemainder`), multi-rate resampling (`16k`, `44.1k`, `48k`), Mono/Stereo, `PCM16` and `PCM32_FLOAT`.
  - Backpressure governance (`WAIT_DRAIN` and `REJECT_OVERLOAD`), duplicate `chunkId` idempotency, mid-stream `cancel()`, and separate Node.js vs Native C++ child process RSS tracking (`/proc/<pid>/status` `VmRSS`).

---

## 3. Phase 1C-C: Streaming Transcript Assembly & Canonical Timeline (`StreamingTranscriptAssembler.ts`)

### 3.1 Canonical Timeline Guarantees (`TC-01..TC-20`)
- **Primary Integer Sample Truth**: `startSample16k`, `endSample16k` (at 16,000 Hz) and exact `BigInt`-scaled `sourceStartSample`, `sourceEndSample` (at `sourceSampleRateHz`).
- **Zero Cumulative Drift**: Verified across 720 consecutive utterances (60 minutes = `57,600,000` canonical samples / `172,800,000` source samples at 48 kHz) with `maxSampleDrift16k = 0` and `maxSourceSampleDrift = 0`.
- **Provisional vs Committed Isolation**: `PARTIAL` events update only `provisionalSegment` and never mutate `finalSegments`.
- **Idempotency & Ordering Guards**: Rejects `DUPLICATE_EVENT_ID`, `STALE_SEQUENCE_ID`, `OUT_OF_ORDER_UTTERANCE`, `STALE_PARTIAL_AFTER_FINAL`, `SESSION_ID_MISMATCH`, and `INVALID_SAMPLE_BOUNDS`.
- **Boundary Overlap Deduplication**: Merges duplicate words inside the chunk overlap tolerance window (`12,800` samples = 800 ms) while preserving genuine speaker repetitions (`من من`, `می‌خواهیم می‌خواهیم`).
- **Honest Granularity**: Marks `WORD` granularity only when real token timestamps exist; marks `SEGMENT` (`wordTimestampsAvailable: false`, `words: []`) when absent.
- **Consumer Adapters**: `toTranscriptDocument()`, `toAvapardazTranscriptResult()`, `toLocalTranscriptionResult()`, `toCoreTranscriptionResult()`.

---

## 4. Phase 1C-D & 1C-E: Non-Destructive Intelligent Audio Editing & Adobe Audition End-to-End Integration (`NonDestructiveAudioEditingBridge.ts`)

### 4.1 Non-Destructive Editing Invariants (`ED-01..ED-27` & `E2E-01..E2E-25`)
- **Existing Healthy Engines Preserved (`OP-DEC-004`)**: Connects `CanonicalTranscriptSnapshot` and `FileBackedChunkedPcmSource` directly to `SpeechEventEngine`, `PersianDisfluencyEngine`, `SilenceAndPauseAnalyzer`, `PersianSemanticRepetitionEngine`, `EditDecisionEngine`, `AudioRenderEngine`, `SmartEditPreviewRenderer`, and `AdobeAuditionHostAdapter`.
- **Source Audio Immutability**: Pre-operation and post-operation streaming SHA-256 verification (`verifySourceAudioUnmodified()`); throws `DESTRUCTIVE_OVERWRITE_FORBIDDEN` if `outputWavPath` equals the source path.
- **FINAL-Only Discipline & Revision Invalidation**: Only `FINAL` segments enter `snapshotToFinalTranscriptDocument()`. Updating the transcript revision (`updateCanonicalTranscriptRevision()`) invalidates overlapping decisions while preserving user approvals on unchanged segments.
- **Preview / Export Sample Parity**: `generatePreview({ mode: 'FULL' })` and `applyApprovedEditsAndExport()` produce identical sample frame counts (`totalOutputFrames === exportedFrames`).
- **Undo/Redo, Double-Application Prevention & Session Persistence**: 64-level `undo()`/`redo()`, `EDIT_PLAN_ALREADY_APPLIED` guard, `serializeSession()` / `restoreFromSerializedSession()`, and `.sesx` v1.9 XML validation (`buildAdobeAuditionBridgePayload()`).

---

## 5. Phase 1C-F & 1C-G: Production Hardening, Multi-Session Stability & Quality Benchmarking

### 5.1 Multi-Session Sequential Memory Stability (20 Sequential Projects)
- Executed 20 sequential audio ingestion + timeline assembly sessions in a single process.
- Heap delta across 20 sessions remained `< 35 MB` with zero zombie child processes and 100% temp directory cleanup (`CLEANED` terminal state).
- Fault injection verified clean rejection on zero-byte files (`AUDIO_INGEST_EMPTY`), corrupt headers (`AUDIO_INGEST_UNSUPPORTED_MAGIC`), and mid-stream cancellation.

### 5.2 Real Persian Speech Quality Benchmarks
- **`test_wavs/0.wav` (14.46s Persian narrative)** & **`test_wavs/1.wav` (2.53s Persian greeting)** & **`models/persian-zipformer-transducer/1.0.0/sample.wav`**:
  - Recognized via real local `sherpa-onnx-streaming-bridge` + `Reza2kn/Shenava-Rizeh` INT8 CTC.
  - Real-Time Factor (RTF): `~0.08 - 0.22` (`4.5x - 12x` faster than real-time on CPU).
  - Offline Air-Gapped operation verified with `http_proxy=http://127.0.0.1:9`, `HF_HUB_OFFLINE=1` (`0` network sockets opened).

---

## 6. Phase 1C-H, 1C-I & 1C-K: Production Packaging, Installer, Update, Rollback, Privacy-Safe Beta Diagnostics & Engineering Handoff

### 6.1 Release Artifacts Generated on Disk (`dist-release/`)
- `dist-release/avapardaz-installer-v2.0.0-beta.1.tar.gz`: Self-contained installer bundle containing Web UI (`payload/app/`), standalone Companion (`payload/companion/avapardaz-companion.mjs`), Native Sherpa binaries & libs (`payload/runtime/`), Persian ASR model (`payload/models/shenava-rizeh-int8/`), Adobe Audition CEP plugin (`payload/cep-extension/ir.avapardaz.audition.cep/`), and executable installers (`installer/install.mjs`, `installer/install-macos.sh`, `installer/uninstall.mjs`).
- `dist-release/avapardaz-update-v2.0.0-beta.2.tar.gz`: Atomic update package for update/rollback verification.
- `dist-release/release-artifacts-manifest.json`: SHA-256 checksums and byte sizes for all release artifacts and documentation.
- `dist-release/docs/`: Complete Persian & English user/operations documentation (`INSTALLATION-GUIDE.md`, `QUICK-START-GUIDE.md`, `SYSTEM-REQUIREMENTS.md`, `RELEASE-NOTES.md`, `KNOWN-ISSUES.md`, `UPDATE-GUIDE.md`, `ROLLBACK-GUIDE.md`, `UNINSTALLATION-GUIDE.md`, `LICENSE-NOTICES.md`).

### 6.2 Verified Lifecycle Scenarios (`BETA-01..BETA-20`)
- **First-Run Statuses**: `READY`, `DEGRADED`, `MODEL_MISSING`, `MODEL_INVALID`, `RUNTIME_ERROR`, `CONNECTION_FAILED`, `VERSION_MISMATCH`, `PERMISSION_DENIED`.
- **Clean-Environment Execution**: Verified installed `sherpa-onnx-offline` + installed model inside a temporary target root with isolated `HOME`, `PATH`, and `LD_LIBRARY_PATH` outside the development repository (`exitCode: 0`, non-empty Persian transcript).
- **Atomic Update & Auto-Rollback**: Active session update deferral (`UPDATE_DEFERRED_ACTIVE_SESSION`), corrupt SHA-256 rejection (`UPDATE_HASH_MISMATCH`), automatic rollback on post-update health check failure (`UPDATE_FAILED_ROLLED_BACK`), and 100% preservation of `user-data/`.
- **Safe Uninstaller**: `STANDARD` mode removes binaries/runtime while preserving `user-data/`; `COMPLETE` mode requires explicit `confirmDeleteUserData: true`.
- **Privacy-Safe Beta Diagnostics & Feedback**: Telemetry disabled by default (`telemetryEnabledByDefault: false`, `autoUploadPermitted: false`), consent-gated diagnostic export with automatic redaction of transcript text, audio paths, and tokens, plus structured local feedback records (`FB-...`).
