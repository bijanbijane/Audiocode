# Silero VAD v5 — pinned ONNX asset

- Architecture: Silero VAD v5, recurrent-state ONNX
- Runtime: ONNX Runtime Web, WASM CPU
- Sample rate: 16 kHz
- Audio frame: 512 samples with 64 samples of left context
- Input tensors: `input` float32 [1, 576], `state` float32 [2, 1, 128], `sr` int64 scalar
- Output tensors: `output` float32 [1, 1], `stateN` float32 [2, 1, 128]
- License: MIT; see LICENSE

The model is fetched during CI from the immutable Hugging Face revision recorded in manifest.json. The downloaded byte count and SHA-256 must match exactly. The ONNX binary is intentionally not committed to Git.

Source attribution: Silero Team, https://github.com/snakers4/silero-vad
Pinned upstream source commit: `60b7ffa243625ebdc1070275a29f18c87843786a`
Reproducible browser ONNX packaging provenance: https://huggingface.co/skillsafe-ai/silero-vad
