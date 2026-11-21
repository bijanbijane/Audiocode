# SHAHAB-021 System Risk Register (Qualitative — Zero Fabricated Probabilities)

| Risk ID | Subsystem | Severity | Release Impact | Failure Scenario | Evidence |
|---|---|---|---|---|---|
| RISK-001 | Release Hardening & Model Lifecycle (SHAHAB-013 / SHAHAB-014) | CRITICAL | **RELEASE_BLOCKER** | Distribution of model/engine updates without cryptographic Ed25519 signature verification. | `docs/shahab/SHAHAB_RELEASE_MANIFEST.json` |
| RISK-002 | Persian Quality Validation Corpus (SHAHAB-006 / SHAHAB-011 / SHAHAB-019) | HIGH | **RELEASE_BLOCKER** | Broad Persian dialect/noise/speaker generalization claimed from frozen benchmark corpus of only n=4 recordings. | `docs/shahab/SHAHAB_OPERATIONAL_STATE.json` |
| RISK-003 | Streaming Architecture (SHAHAB-017) | MEDIUM | **ACCEPTABLE_WITH_LIMITATION** | Inherited encoder.int8.onnx has no stateful cache tensors; streaming uses incremental sliding windows. | `docs/shahab/SHAHAB_STREAMING_CAPABILITY_REPORT.md` |
| RISK-004 | Cross-Platform Portability & Footprint (SHAHAB-018 / SHAHAB-020) | MEDIUM | **HIGH_RISK** | Uncompressed model package is 110.41 MiB (>100 MiB) and WebGPU/Native C++ providers are unavailable/blocked. | `docs/shahab/SHAHAB_RUNTIME_STATE.json` |
| RISK-005 | Production Resilience SLIs (SHAHAB-015) | LOW | **ACCEPTABLE_WITH_LIMITATION** | Zero real production fleet invocations recorded so far. | `docs/shahab/SHAHAB_RESILIENCE_STATE.json` |
