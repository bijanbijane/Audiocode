# SHAHAB Blockers & Limitations

- **BLK-001 [MEDIUM] (Hardware / Acceleration):** 0 GPUs, no CUDA/ROCm, no WebGPU, no sherpa-onnx C++ binary in current container (CPU WASM verified only).
- **BLK-002 [MEDIUM] (Package Size (< 100 MiB)):** Uncompressed mandatory on-disk package is 115.77 MB (110.41 MiB) · 115,768,868 B, exceeding 100.00 MiB uncompressed target.
- **BLK-003 [CRITICAL] (Release Signing):** External Ed25519 release signing key infrastructure not provisioned (signing status=BLOCKED; automatic rollout disabled).
- **BLK-004 [LOW] (Workspace P0-011):** No standalone P0-011 linguistic module exists in workspace; P0-009, P0-010, and P0-012 are integrated directly.
- **BLK-005 [HIGH] (Field Evaluation Data):** Only 1 independent real Persian recording + derived stress variants available locally (n=4 < 20 required for statistical release claims).
- **BLK-006 [MEDIUM] (Trainable Checkpoint):** Upstream ramin-mahmoodi/persian-zipformer-asr repo publishes inference-only ONNX files and no PyTorch/Icefall .pt checkpoint.
