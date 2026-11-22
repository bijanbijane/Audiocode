# Speaker embedding model assets

Speaker diarization uses a separately versioned ONNX embedding model. The binary is intentionally excluded from Git; CI downloads the pinned file and verifies exact byte count and SHA-256 before inference.

## Current evaluation candidate: WeSpeaker ECAPA-TDNN512-LM

- Upstream: [Wespeaker/wespeaker-ecapa-tdnn512-LM](https://huggingface.co/Wespeaker/wespeaker-ecapa-tdnn512-LM)
- Immutable source revision: `a2f3dcb1c8702caccc7a55ceb57f5e8d1842112b`
- Asset: `voxceleb_ECAPA512_LM.onnx`
- Size: 24,861,931 bytes
- SHA-256: `d71b85d9b48058ef68004f04f1b78acebefb9dfcf542e19b976a12a5ad1f10b0`
- Declared upstream license: CC-BY-4.0; see [NOTICE](./NOTICE)
- Embedding dimension: 192
- Training domain stated by the model card: VoxCeleb2 Dev (English celebrity interview recordings)

The upstream ONNX graph contract is `feats: float32 [1,T,80]` to `embs: float32 [1,192]`. It is a **feature-input model**, not a waveform-input model.

## Official WeSpeaker diarization subsegment contract

The official diarization recipe does not simply crop a 1.5-second waveform and use the naturally resulting 148 FBANK frames. It computes FBANK for each VAD region first, derives subsegment length/shift in 10 ms frames (150/75 by default), resizes each selected feature matrix to a fixed 150-frame window using the same repeat-to-fill behavior as WeSpeaker's `np.resize`, and applies CMN per subsegment before ONNX inference.

`SpeakerEmbeddingOnnxRunner` now follows this sequence in `KALDI_FBANK` mode. The regression suite asserts the fixed `[1,150,80]` tensor shape and checks per-bin CMN over all 150 frames. The actual ONNX smoke uses two overlapping 1.5-second windows at a 0.75-second hop.

This follows the upstream diarization framing more closely than the earlier raw waveform-window path. Independent numerical parity against the upstream Torchaudio/Kaldi implementation remains an explicit pending gate.

## Required frontend contract

The dedicated `WespeakerKaldiFbank80` implementation is intentionally separate from SHAHAB's Whisper/Conformer Log-Mel frontend.

- Input audio: mono Float32 PCM normalized to approximately [-1,1], 16 kHz
- Scale: multiply waveform by 2^15 before Kaldi FBANK computation
- Window: Hamming, 25 ms (400 samples)
- Frame shift: 10 ms (160 samples), snip edges enabled
- FFT: 512 points
- Features: 80 triangular Mel bins, power spectrum, log filterbank
- Dither: 0 at inference, matching WeSpeaker's `Speaker.compute_features()` default
- Normalization: subtract utterance mean independently per Mel bin
- Tensor layout: `[1,T,80]`
- Embedding postprocessing: L2 normalization by AvaPardaz runner

The implementation must not substitute the existing Whisper-style Log-Mel frontend or the waveform-native SpeechBrain contract. See the [official WeSpeaker inference implementation](https://github.com/wenet-e2e/wespeaker/blob/master/wespeaker/cli/speaker.py), the [ONNX exporter](https://github.com/wenet-e2e/wespeaker/blob/master/wespeaker/bin/export_onnx.py), and its [VoxCeleb recipe](https://github.com/wenet-e2e/wespeaker/blob/master/examples/voxceleb/v2/conf/ecapa_tdnn_lm.yaml).

## Verification status

**Full model and local-service smoke passed** in GitHub Actions on Linux using ONNX Runtime Web/WASM CPU, workflow [45074800631](https://github.com/bijanbijane/Audiocode/actions/runs/45074800631), commit `ef2a27fd047a225e0d9ae2d2e3c3e40d17e8f513`.

- The 24,861,931-byte model was downloaded from the pinned immutable revision and its byte length and SHA-256 were verified.
- The updated official-style WeSpeaker subsegment path used 1.5-second windows, 0.75-second hop, fixed 150-frame / 80-bin FBANK tensors, and produced two finite L2-normalized 192-dimensional embeddings from the pinned 12.12-second Persian WAV.
- WeSpeaker embedding smoke: 339.95 ms for 2.25 seconds of VAD speech coverage (two 1.5-second windows with 0.75-second hop); speech-window RTF 0.1511. The 12.12-second file-level RTF is reported separately for the integrated pipeline.
- The integrated local service loaded both real Silero VAD and real WeSpeaker ONNX models, ran VAD followed by speaker embedding and anonymous clustering, and completed with 4 output speaker clusters, 4 output segments, and 0.0 seconds left unassigned. Whole-service elapsed time: 825.04 ms; RTF 0.0681.
- The separate real Silero smoke detected 2 speech segments (5.816 seconds total) in 448.08 ms; RTF 0.0370.
- The same product workflow also passed SHAHAB real Zipformer inference/parity (14/14), canonical P0 tests (30/30), model/secret bundle exclusion, product build/lint and CEP packaging checks.

The reported four speaker clusters are only the raw output count for one sample. There is no human-annotated speaker reference for that sample, so this result does **not** mean four speakers were correctly identified. A smoke test verifies model loading and that the integrated path produces structurally valid output; it does **not** verify speaker separation quality, DER, JER, false merges, false splits or Persian generalization.

The custom frontend now follows the upstream subsegment framing and per-window CMN behavior. Independent numerical parity against the official Torchaudio/Kaldi implementation remains open. The model remains an evaluation candidate, not production-approved, until all of these gates pass:

1. Frontend numerical parity against the official Kaldi/Torchaudio reference implementation.
2. Licensed, independently annotated Persian multi-speaker evaluation with DER, JER, false merges/splits, short turns and overlap analysis.
3. Memory and real-time factor qualification on the target Mac M2 with 8 GB RAM.
4. End-to-end validation in the Adobe Audition host and the product's actual application/model lifecycle.

The source model was trained on VoxCeleb2; results on that dataset do not imply equal performance on Persian speech or AvaPardaz recording conditions.
