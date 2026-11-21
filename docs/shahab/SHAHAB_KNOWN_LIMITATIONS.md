# Known Limitations — SHAHAB-R2.0.0-RELEASE-CANDIDATE

- Uncompressed mandatory model package is 110.41 MiB (> 100 MiB uncompressed target).
- Release cryptographic signing is BLOCKED (no external signing key infrastructure provisioned).
- Native GPU / CUDA / ROCm and Browser WebGPU are BLOCKED (0 GPUs in container).
- Offline stateless7 ONNX graph uses chunked overlap streaming rather than recurrent encoder streaming state.
- Word-level forced alignment and speaker diarization are unavailable and not fabricated.
