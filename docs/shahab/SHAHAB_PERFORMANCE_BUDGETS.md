# SHAHAB Evidence-Based Performance Budgets

| Budget ID | Scope | Observed | Limit | Status |
|---|---|---:|---:|---|
| BUDGET-RTF-WARM-BALANCED | Local CPU WASM — BALANCED (beam=4) warm inference | 0.079 RTF | <= 0.75 RTF | WITHIN_BUDGET |
| BUDGET-COLD-LOAD-MS | Local CPU WASM — Cold 3-session ONNX load | 2406 ms | <= 5000 ms | WITHIN_BUDGET |
| BUDGET-MEMORY-RSS-PEAK-MB | Process RSS during 15s audio inference | 873.1 MiB | <= 1024 MiB | WITHIN_BUDGET |
| BUDGET-ENCODER-CACHE-HIT-SAVING | Re-decoding with new policy / context using cached encoder output | 170.551 ms | <= 566.6 ms | WITHIN_BUDGET |
