# SHAHAB Performance Contract (1.0.0-shahab-016)

- **Mission:** SHAHAB-016
- **Generated UTC:** 2026-11-21T19:06:52.520Z
- **Runtime:** onnxruntime-web@1.31.1 (Node WASM)
- **Trainable Parameters:** 0 (frozen inherited Zipformer INT8 weights)

## Metric Definitions
- **RTF:** `processingWallTimeSec / audioDurationSec` (strictly invalid if `audioDurationSec <= 0`).
- **Cold Startup:** Fresh `SHAHABFrozenModelAdapter.initializeRuntime()` across encoder+decoder+joiner ONNX sessions (2406 ms).
- **Warm Startup:** Cached session check (0.011 ms).
- **Percentiles:** Non-parametric empirical P50 / P95 / P99 over separated warm runs (never mixing cold & warm).
