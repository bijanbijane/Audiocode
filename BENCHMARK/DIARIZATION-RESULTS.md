# Speaker Diarization — Evidence and Benchmark Status

**Document version:** 2.1.0  
**Current status:** Real ONNX inference and integrated local VAD-to-WeSpeaker smoke passed; Persian diarization quality evaluation is pending.

## 1. Latest reproducible runtime evidence

The pinned WeSpeaker ECAPA-TDNN512-LM ONNX model was downloaded from immutable revision
`a2f3dcb1c8702caccc7a55ceb57f5e8d1842112b`. The 24,861,931-byte file matched manifest SHA-256
`d71b85d9b48058ef68004f04f1b78acebefb9dfcf542e19b976a12a5ad1f10b0`.

GitHub Actions product workflow [45074800631](https://github.com/bijanbijane/Audiocode/actions/runs/45074800631), commit
`ef2a27fd047a225e0d9ae2d2e3c3e40d17e8f513`, ran the real ONNX graph with ONNX Runtime Web/WASM on CPU:
- Model input: 80-bin Kaldi-FBANK, fixed 150-frame windows, 1.5-second window / 0.75-second hop
- Output: two finite, L2-normalized 192-dimensional embeddings from the pinned 12.12-second Persian WAV
- Embedding inference time: 339.95 ms
- Embedding smoke RTF: 0.1511 (measured against the 12.12-second source file)

The same workflow ran the actual local service with **both** Silero VAD and WeSpeaker ONNX models:
- Source duration: 12.12 seconds
- Assigned anonymous cluster count: 4
- Output segments: 4
- Unassigned duration: 0.0 seconds
- Whole-service elapsed time: 825.04 ms
- Whole-service RTF: 0.0681

The separate real Silero VAD smoke on the same source detected 2 speech intervals (5.816 seconds total) in 448.08 ms (RTF 0.0370). SHAHAB real Zipformer inference/parity was 14/14; canonical P0 tests were 30/30. Product Level 1–5, packaging, and quality checks passed on that commit.

**Important interpretation:** the four output clusters are only the algorithm's raw cluster count for one unannotated sample. There is no human reference for the true speaker count in this sample. This is not evidence of four correctly identified speakers or of diarization accuracy. These tests establish model loading, a finite embedding and a complete local execution path; they do not measure DER/JER, false merges, false splits, overlap quality or Persian generalization.

An earlier smoke in run [45072803347](https://github.com/bijanbijane/Audiocode/actions/runs/45072803347) used a 2.02-second / 200-frame window and is superseded by the latest official-style 150-frame subsegment run.

## 2. Frontend and runner status

- A dedicated Kaldi-style 80-bin FBANK frontend is implemented separately from SHAHAB's Whisper/Conformer Log-Mel frontend.
- Base feature settings: 16 kHz mono, 25 ms Hamming window, 10 ms frame shift, 512-point FFT, 80 Mel bins, log power, dither disabled, and per-bin CMN.
- For WeSpeaker diarization, FBANK is computed per VAD region; fixed 150-frame subsegments are then formed with 75-frame shifts, short/tail matrices are repeated to the fixed shape following the upstream `np.resize` pattern, and CMN is applied per subsegment.
- Runner's WeSpeaker mode uses `feats` and `embs` tensors and L2-normalizes output embeddings.
- Unit tests verify dimensions, finite output, silence handling, fixed 150-frame shape, and CMN behavior.
- Independent numerical parity against the official Torchaudio/Kaldi implementation is still pending.
- The model was trained on VoxCeleb2 Dev; Persian speech and AvaPardaz recording conditions have not yet been benchmarked.

## 3. Product behavior and evidence rules

- `LocalWeSpeakerDiarizationService` verifies both local model artifacts by exact size and SHA-256 before session creation, loads VAD and speaker models, and rolls back partial initialization on failure.
- The service runs local Silero VAD followed by WeSpeaker embeddings and anonymous, recording-local speaker clustering; it does not attempt to identify a real person or match voices across recordings.
- The async model-backed capability retains VAD speech not covered by embedding windows as `UNKNOWN_SPEAKER`; it does not fabricate labels for omitted speech.
- The generic synchronous fallback no longer fabricates alternating speaker labels from silence gaps or transcript order. Without model evidence or explicit upstream speaker hints, it returns `UNKNOWN_SPEAKER`.
- The capability registry currently marks application-level diarization as degraded / partially implemented because the separately tested local WeSpeaker service is not yet connected to the main orchestrator's installed-model lifecycle and user-facing workflow.
- Multi-track crosstalk analysis remains a separate energy/phase-based capability; it is not equivalent to single-channel neural diarization.

## 4. Previous Phase 3 figures — withdrawn

Earlier drafts included claims such as 100% speaker-count accuracy, 94.2% boundary hit rate and simulated DER 4.8%/9.4%.
Those figures were not backed by a reproducible, independently annotated benchmark protocol and must **not** be presented as
measured model quality. They are withdrawn from release evidence until source audio, speaker annotations, scoring scripts,
collar/overlap policies and reproducible run outputs are archived.

## 5. Required Persian evaluation gates

Before production approval, run a licensed, manually annotated, multi-speaker Persian corpus with:
1. Speaker-attributed reference turns, including bilingual/code-switch and overlapping speech cases.
2. DER and JER under declared collar and overlap-scoring policies.
3. Speaker confusion, missed speech, false alarm, false merge and false split rates.
4. Per-condition analysis: 2–8 speakers, turn duration, noise, microphone distance, reverberation and channel count.
5. Frontend numerical parity against upstream Kaldi/Torchaudio and reproducible test fixtures.
6. CPU/WASM memory and latency qualification on the target Mac M2 8 GB device, including coexistence with Adobe Audition.
7. End-to-end wiring of the local model lifecycle and diarization capability into the product orchestrator.

Until these gates pass, WeSpeaker remains an evaluation candidate with verified CPU inference, not a Persian-quality-approved
production diarization engine.
