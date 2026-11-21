# SHAHAB-015 — Resource Protection Policy & Observed Measurements

## Latest Observed Measurements (Actual Platform APIs)
- **Process RSS:** 966.23 MiB (1013161984 bytes)
- **Process Peak RSS:** 966.23 MiB
- **Process Heap Used / Total:** 21.04 / 26.65 MiB
- **Host Total / Free RAM (distinct from process):** 12.00 / 10.13 GiB
- **Measured Available Storage (`fs.statfsSync`):** 503.22 GiB (`MEASURED`)

## Concurrency & Memory Safeguards
- `maxConcurrentModelLoads = 1` (exclusive serialization lock prevents concurrent ONNX initialization storms).
- `maxConcurrentInferenceJobs = 2` (excess requests enter bounded queue).
- Storage preflight compares measured available space against actual manifest artifact bytes + temporary overhead + 64 MiB explicit safety margin.
