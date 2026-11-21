# SHAHAB Runtime Conformance Report

Passed: **6 / 6**

| Test ID | Category | Result | Detail |
|---|---|---|---|
| CONF-INIT-01 | INIT | PASS | Initialized 3 ONNX sessions; SHA-256 immutable=true; vocab=1024. |
| CONF-INPUT-01 | INPUT | PASS | Empty audio buffer rejected with typed AUDIO_INVALID error. |
| CONF-OUTPUT-01 | OUTPUT | PASS | Unified contract returned provider=wasm, segments=1, textLen=67. |
| CONF-CANCEL-01 | CANCELLATION | PASS | Pre-aborted AbortSignal rejected cleanly with JOB_CANCELLED. |
| CONF-NEG-01 | NEGOTIATION | PASS | UnauthorizedCloud=BLOCKED_CLOUD_AUTHORIZATION_REQUIRED; ModelSub=BLOCKED_MODEL_SUBSTITUTION_FORBIDDEN; WebGpuAuto=SELECTED_LOCAL_WASM (fallbackApplied=true). |
| CONF-FAIL-01 | FAILURE | PASS | Hash-mismatched model blocked with MODEL_INTEGRITY_FAILURE. |
