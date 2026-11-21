# SHAHAB Target Platform Registry

| Target ID | Provider | Status | Offline | Blockers |
|---|---|---|---|---|
| NODE_LOCAL_WASM_CPU | wasm | **VERIFIED_AVAILABLE** | Yes | None |
| CLOUD_UNIFIED_SERVER | cloud_api | **VERIFIED_AVAILABLE** | No | Requires explicit user authorization before transferring any audio off-device. |
| BROWSER_LOCAL_WASM | wasm | **AVAILABLE_BUT_UNVERIFIED** | Yes | 110.41 MiB uncompressed model exceeds comfortable cold browser-tab download without OPFS pre-caching and headless-browser inference verification. |
| NATIVE_CPP_ONNXRUNTIME | cpu_native | **UNAVAILABLE** | Yes | Native C++ binary addon not installed in container environment. |
| WEBGPU_OR_CUDA_ACCEL | webgpu | **BLOCKED** | Yes | No hardware GPU / CUDA driver available in headless container environment. |
