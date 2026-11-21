# SHAHAB Streaming Capability Report

- **Encoder ONNX Inputs:** `x, x_lens`
- **True Stateful Streaming:** `NOT_SUPPORTED_BY_MODEL`
- **Selected Production Streaming Mode:** `INCREMENTAL_WINDOWED_INFERENCE`
- **Rationale:** Encoder graph exposes only offline inputs [x, x_lens] with zero cache tensors; true stateful streaming is NOT_SUPPORTED_BY_MODEL. SHAHAB implements bounded INCREMENTAL_WINDOWED_INFERENCE with timestamp-aligned overlap reconciliation.
