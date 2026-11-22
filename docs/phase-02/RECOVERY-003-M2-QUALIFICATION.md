# AVAPARDAZ — PHASE-02 RECOVERY-003 APPLE SILICON M2 (8 GB) QUALIFICATION STATUS

**Document ID:** `AVP-P02-REC003-M2-001`  
**Execution Series:** `AVP-P02-RECOVERY-003` / `RECOVERY-004` / `RECOVERY-005`  
**Date (UTC):** `2026-11-22`  
**Hardware Availability:** `M2_HARDWARE = NOT_AVAILABLE`  
**Portable Validation Kit Status:** `M2_TEST_KIT = VERIFIED / PREPARED`  
**Physical Qualification Verdict:** `PHYSICAL_M2_TEST = NOT_RUN` (`BLOCKED`)

---

## 1. Execution Host Hardware Verification (`[Observed Fact]`)

Direct host inspection confirms that the current execution environment is a Linux container, **not** physical Apple Silicon hardware:

- **Kernel / OS:** Linux `4.19.0` (gVisor sandbox), `x86_64`
- **Physical Apple Silicon M2 (`arm64`, Darwin, 8 GB unified memory):** **NOT PRESENT**
- **Adobe Audition macOS coexistence environment:** **NOT PRESENT**
- **Apple Silicon thermal / powermetrics / unified memory pressure telemetry:** **NOT PRESENT**

Per non-negotiable Phase-02 constraints:
- Linux `x86_64` CPU measurements are **never** extrapolated to Apple Silicon M2 (`8 GB`).
- `M2_COMPATIBILITY` remains `UNTESTED / NOT_RUN` until executed directly on physical Apple M2 (`8 GB`) hardware.

---

## 2. Portable Apple Silicon M2 (`8 GB`) Validation Kit

To make physical M2 qualification turnkey and tamper-evident as soon as hardware is available, a complete, self-contained validation kit was authored and preflight-verified under `tools/phase02/m2-validation/`:

| File | Purpose | Verification Performed |
| --- | --- | --- |
| `tools/phase02/m2-validation/run_m2_validation.sh` | Entry-point shell wrapper enforcing `Darwin` + `arm64` + `Apple M2` + `8 GB` hardware guard, CPU-only (`NO_METAL`) mode, and offline network check | `bash -n` **PASS**; fail-safe abort on Linux `x86_64` verified (`exit code 10`) |
| `tools/phase02/m2-validation/setup_m2_artifacts.sh` | Downloads pinned macOS `arm64` `sherpa-onnx` binaries and model artifacts and validates exact SHA-256 digests | `bash -n` **PASS** |
| `tools/phase02/m2-validation/config.json` | Kit version `3.0.0`, hardware constraints (`Darwin`/`arm64`/`Apple M2`/`8 GiB ± 0.5 GiB`, `CPU_ONLY_NO_METAL`), acceptance thresholds, and pinned SHA-256 hashes for `Shenava-Rizeh v1.0 INT8` & `whisper-large-v3-turbo INT8` | Validated by `m2_runner.py --dry-run-preflight` **PASS** |
| `tools/phase02/m2-validation/m2_runner.py` | Runs cold-start (`3x`), warm (`5x`), 50-job stability soak, `vm_stat` / `sysctl vm.swapusage` / `memory_pressure` telemetry, Audition coexistence tracking, and emits JSON evidence + SHA-256 manifest | `py_compile` **PASS**; `--dry-run-preflight` **PASS** |
| `tools/phase02/m2-validation/README.md` | Operator runbook (exact commands for artifact staging, Wi-Fi/Ethernet physical disconnect, Audition launch, and evidence packaging) | Reviewed & complete |

### 2.1 Fail-Safe Enforcement Proof (`[Observed Fact]`)

Running `bash tools/phase02/m2-validation/run_m2_validation.sh` on this Linux `x86_64` host immediately aborted with exit code **`10`** (`FAILSAFE_EXIT_CODE=10`), proving the kit cannot accidentally record non-M2 measurements as M2 qualification evidence.

---

## 3. Locked M2 Acceptance Thresholds (`config.json`)

| Gate Metric | Mandatory Threshold | Preferred Target | Current Status |
| --- | --- | --- | --- |
| Target Hardware | Physical `Darwin` / `arm64` / `Apple M2` / `8 GB` unified RAM | Same | **NOT_RUN** |
| Execution Mode | `CPU_ONLY_NO_METAL` (`--provider=cpu`, `4` threads) | Same | **NOT_RUN** |
| Median CPU RTF | `<= 1.00` | `<= 0.50` | **NOT_RUN** |
| Peak Process Memory | `<= 5.0 GiB` | `<= 4.0 GiB` | **NOT_RUN** |
| Post-Warmup Swap Growth | `<= 512.0 MiB` | `0 MiB` | **NOT_RUN** |
| Consecutive Mixed Jobs | `50` jobs (`0` crashes) | Same | **NOT_RUN** |
| Adobe Audition Coexistence | Live timeline scrub + playback responsive during ASR | Zero audio dropouts | **NOT_RUN** |
| Sustained Thermal / Throttle | 30-min continuous load without runaway RTF degradation | `< 15%` thermal RTF drift | **NOT_RUN** |

---

## 4. Required Operator Action on Physical M2 Hardware

```bash
cd tools/phase02/m2-validation
chmod +x setup_m2_artifacts.sh run_m2_validation.sh
./setup_m2_artifacts.sh
# Standalone baseline (process-scoped macOS sandbox-exec offline isolation):
./run_m2_validation.sh --profile full --allow-audition-absent
# Adobe Audition coexistence run (open Adobe Audition with a 30-min multitrack session):
./run_m2_validation.sh --profile full
```

Commit the resulting `evidence_output/m2-run-<UTC>/` bundle (all 13 JSON/log/manifest artifacts) back into `evidence/phase02/m2-physical/` to clear `M2_QUALIFICATION`.
