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

**Real model runtime smoke passed** on the GitHub Actions Linux runner using ONNX Runtime Web/WASM CPU:
- The exact 24,861,931-byte asset was downloaded from the pinned revision and SHA-256 verified.
- A 2.02-second window (200 FBANK frames) from the pinned Persian WAV produced a finite, L2-normalized 192-dimensional embedding.
- Inference: 276.58 ms; RTF 0.1369.
- Workflow run: [45072803347](https://github.com/bijanbijane/Audiocode/actions/runs/45072803347), commit `3b90311f9265c5fdb9bd1081032065120edec498`.

This verifies model loading and one real inference path. It does **not** verify embedding quality or speaker separation accuracy. The frontend has dedicated unit/contract tests, but an independent numerical parity comparison against the upstream Torchaudio/Kaldi implementation remains open.

The pinned asset now has a reproducible CI acquisition manifest and a real ONNX Runtime Web/WASM CPU smoke test. This smoke verifies that the graph can produce a finite, normalized 192-dimensional vector from the test WAV. It does **not** establish Persian speaker diarization accuracy.

The model remains an evaluation candidate, not production-approved, until all of these gates pass:

1. Real ONNX/WASM inference and asset-integrity checks.
2. Frontend numerical parity against the official Kaldi/Torchaudio reference implementation.
3. Licensed, independently annotated Persian multi-speaker evaluation with DER, JER, false merges/splits, short turns and overlap analysis.
4. Memory and real-time factor qualification on the target Mac M2 with 8 GB RAM.
5. End-to-end validation in the Adobe Audition plugin and the product's local/offline pipeline.

The source model was trained on VoxCeleb2; results on that dataset do not imply equal performance on Persian speech or the AvaPardaz recording conditions.
