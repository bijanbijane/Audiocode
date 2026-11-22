# Speaker Diarization — Evidence and Benchmark Status

**Document version:** 2.0.0
**Current status:** Real ONNX runtime smoke passed; Persian diarization quality evaluation is pending.

## 1. Real model runtime evidence

The pinned WeSpeaker ECAPA-TDNN512-LM ONNX model was downloaded from immutable revision
`a2f3dcb1c8702caccc7a55ceb57f5e8d1842112b`. The 24,861,931-byte file matched the manifest SHA-256
`d71b85d9b48058ef68004f04f1b78acebefb9dfcf542e19b976a12a5ad1f10b0`.

GitHub Actions run [45072803347](https://github.com/bijanbijane/Audiocode/actions/runs/45072803347) executed
the actual ONNX graph with ONNX Runtime Web/WASM on CPU:
- Input: one 2.02-second, 200-frame, 80-bin Kaldi-FBANK window from the pinned Persian WAV sample
- Output: one finite, L2-normalized 192-dimensional speaker embedding
- Inference time: 276.58 ms
- RTF for that single window: 0.1369

This is a **model-load and inference smoke test**. It does not measure diarization accuracy, speaker count accuracy,
DER, JER, false merges, false splits, overlap handling, or generalization to Persian conversations.

## 2. Frontend and runner status

- A dedicated Kaldi-style 80-bin FBANK frontend is implemented separately from SHAHAB's Whisper/Conformer Log-Mel frontend.
- Input contract: 16 kHz mono, 25 ms Hamming window, 10 ms frame shift, 512-point FFT, 80 Mel bins, log power, and per-utterance per-bin CMN.
- Runner supports a specific `KALDI_FBANK` mode and the real ONNX/WASM smoke test uses tensor names `feats` and `embs`.
- Unit tests verify dimensions, finite output, silence handling, CMN behavior, and integration tensor shape.
- Independent numerical parity against the official Torchaudio/Kaldi implementation is still pending.
- The model was trained on VoxCeleb2 Dev; Persian speech and AvaPardaz recording conditions have not yet been benchmarked.

## 3. Product behavior and evidence rules

- A loaded local WeSpeaker runner can be passed to `runWeSpeakerDiarizationCapability` together with Silero VAD segments and 16 kHz PCM.
- The function emits anonymous, recording-local speaker labels; it does not attempt to identify a real person or match voices across recordings.
- The generic synchronous fallback no longer fabricates alternating speaker labels from silence gaps or transcript order. When model evidence or explicit upstream speaker hints are absent, it returns `UNKNOWN_SPEAKER`.
- Multi-track crosstalk analysis remains a separate energy/phase-based capability; it is not equivalent to single-channel neural diarization.

## 4. Previous Phase 3 figures — not validated benchmarks

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
5. Frontend parity against upstream Kaldi/Torchaudio and reproducible test fixtures.
6. CPU/WASM memory and latency on the target Mac M2 8 GB device, including coexistence with Adobe Audition.

Until these gates pass, WeSpeaker remains an evaluation candidate with verified CPU inference, not a Persian-quality-approved
production diarization engine.
