# Speaker embedding model assets

This directory intentionally contains no model weights yet. Do not mark speaker diarization as model-verified until a pinned asset has passed the acquisition, runtime and evaluation gates below.

## Candidate under review (not adopted)

Candidate: [kenrunio/transcriber-speaker-onnx](https://huggingface.co/kenrunio/transcriber-speaker-onnx)

Its model card describes an Apache-2.0 ONNX export of SpeechBrain ECAPA-TDNN with the 80-band feature frontend and normalization included in the graph. The documented inputs are:
- `wav`: float32, shape `[batch, samples]`, 16 kHz mono PCM
- `lens`: float32, shape `[batch]`, fraction of each row containing real audio
- `emb`: float32, shape `[batch, 1, 192]`

The model card states that the weights come from SpeechBrain's `spkrec-ecapa-voxceleb`, trained on VoxCeleb 1 and 2, and reports ONNX/PyTorch embedding parity. These are upstream claims, not AvaPardaz validation results.

**Adoption is blocked** until an immutable repository revision, exact byte size, SHA-256, license/attribution files and file provenance are verified. The default `main` branch is not an acceptable production pin. The candidate must also pass a Persian multi-speaker evaluation; model-export parity alone does not establish diarization accuracy on Persian audio.

## Runtime contract

`SpeakerEmbeddingOnnxRunner` supports:
- `LOG_MEL_FEATURES`: the existing generic Log-Mel/CMVN frontend. This is not asserted to reproduce SpeechBrain Fbank.
- `WAVEFORM`: pass raw 16 kHz mono PCM and a length tensor directly to a graph that embeds its own feature frontend. Tensor names are configurable.

No candidate asset is automatically downloaded or loaded by the application.

## Required gates before adoption

1. Pin an immutable upstream commit and declare exact path, byte size, SHA-256, license and required attribution files in a manifest.
2. Download at CI/runtime setup from the pinned revision; verify all bytes and hashes before ONNX session creation.
3. Inspect and assert the exact ONNX input/output tensor names, types and shapes.
4. Run actual ONNX Runtime WASM/CPU inference on a licensed Persian multi-speaker sample with at least two known speakers. Keep mock tests separate from this smoke test.
5. Evaluate same-speaker and different-speaker embedding distributions, diarization error rate (DER), Jaccard error rate (JER), false merges/splits, short-turn behavior and overlap handling against human-annotated reference audio.
6. Measure memory and real-time factor on the target Mac M2/8 GB device; test coexistence with Adobe Audition.

Until these gates pass, the diarization engine remains **implemented / tested at contract level, not model-verified**.
