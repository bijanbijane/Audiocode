# SHAHAB-015 — Isolated Fault-Injection Test Report

- **Run ID:** `fi-run-eca4abe1-5`
- **Executed At:** `2026-11-21T19:06:52.493Z`
- **Isolated Environment Only:** `true` (production data touched: `false`)
- **Score:** **11 / 11** passed

| Test ID | Category | Fault Injected | Recovery | Data Integrity | Passed |
|---|---|---|---|---|---|
| `FI-PROC-01` | `PROCESS` | Terminate worker during preprocessing | `CONTAINED_SAFELY` | `INTACT_VERIFIED` | PASS |
| `FI-PROC-02` | `PROCESS` | Crash/restart during encoder execution on chunk 1 + duplicate completion event | `RECOVERED_VERIFIED` | `INTACT_VERIFIED` | PASS |
| `FI-PROC-03` | `PROCESS` | Decoder/persistence interruption attempting partial overwrite + user cancellation | `CONTAINED_SAFELY` | `INTACT_VERIFIED` | PASS |
| `FI-STOR-01` | `STORAGE` | Simulated ENOSPC disk full during atomic write + low-space preflight | `CONTAINED_SAFELY` | `INTACT_VERIFIED` | PASS |
| `FI-STOR-02` | `STORAGE` | Mid-write EIO interruption after writing 1/3 of temp file | `CONTAINED_SAFELY` | `INTACT_VERIFIED` | PASS |
| `FI-STOR-03` | `STORAGE` | Post-write tampering of checkpoint payload JSON | `CONTAINED_SAFELY` | `CORRUPTION_BLOCKED` | PASS |
| `FI-MEM-01` | `MEMORY` | Memory pressure cache eviction + 3 simultaneous model initialization calls | `CONTAINED_SAFELY` | `INTACT_VERIFIED` | PASS |
| `FI-NET-01` | `NETWORK` | Unauthorized LOCAL->CLOUD fallback + Cloud REQUEST_TIMEOUT + duplicate Cloud delivery | `RECOVERED_VERIFIED` | `INTACT_VERIFIED` | PASS |
| `FI-INT-01` | `INTEGRITY` | Post-manifest artifact tamper + incompatible tokenizer + mismatched recording + unsupported schema version 99.0.0 | `CONTAINED_SAFELY` | `CORRUPTION_BLOCKED` | PASS |
| `FI-UPD-01` | `UPDATE_INSTALL` | Interrupted/corrupted artifact extraction during staged installation + simulated activation crash rollback | `ROLLBACK_VERIFIED` | `INTACT_VERIFIED` | PASS |
| `FI-DEG-01` | `INTEGRITY` | Optional contextual vocabulary subsystem exception | `RECOVERED_VERIFIED` | `INTACT_VERIFIED` | PASS |
