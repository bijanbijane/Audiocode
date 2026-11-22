# AVAPARDAZ — Portable Apple Silicon M2 (8 GB) CPU-Only Validation Kit

**Kit Status:** `PORTABLE_M2_TEST_KIT = PREPARED`  
**Hardware Validation Status:** `M2_HARDWARE_VALIDATION = NOT_RUN` *(must be executed on physical Apple Silicon M2 with 8 GB unified memory)*

---

## Quick Start on Physical Apple Silicon M2 (8 GB)

1. **Place evaluation audio (16 kHz Mono PCM16 WAV) into `audio/`:**
   - Copy Persian + English clips into `tools/phase02/m2-validation/audio/`.
   - Copy the continuous 30–60 minute recording as `tools/phase02/m2-validation/audio/long_recording_16k.wav`.
2. **Single-Command Setup + Standalone CPU-Only Baseline (Audition closed):**
   ```bash
   cd tools/phase02/m2-validation && chmod +x setup_m2_artifacts.sh run_m2_validation.sh && ./run_m2_validation.sh --auto-setup --profile full --allow-audition-absent
   ```
   *(The `--auto-setup` flag executes the explicit SHA-256-verified download stage `setup_m2_artifacts.sh` once before running the offline benchmark.)*
3. **Run Adobe Audition Coexistence Qualification (open Adobe Audition with a real multi-track/podcast project loaded, no re-download needed):**
   ```bash
   ./run_m2_validation.sh --profile full
   ```

---

## Safety & Cleanup Guarantees

- **Zero permanent system changes:** Uses macOS `sandbox-exec -p '(version 1)(allow default)(deny network*)'` for process-scoped offline isolation without modifying Wi-Fi, macOS Firewall, or system settings.
- **CPU-only enforced:** Passes `--provider=cpu` explicitly so CoreML/Metal GPU acceleration is never silently activated.
- **Fail-safe preflight:** Automatically aborts with exit code `10` if executed on non-macOS, non-ARM64, non-M2, or non-8GB hardware.
- **Cleanup:** Delete `tools/phase02/m2-validation/artifacts/` and `tools/phase02/m2-validation/evidence_output/` when finished.

---

## Generated Evidence Bundle (`evidence_output/m2-run-<UTC>/`)

Produces all 13 mandatory artifacts:
`M2_HARDWARE_REPORT.json`, `MODEL_INVENTORY.json`, `BENCHMARK_RESULTS.json`, `BENCHMARK_RESULTS.jsonl`, `STABILITY_REPORT.json`, `LONG_AUDIO_REPORT.json`, `OFFLINE_VERIFICATION_REPORT.json`, `MEMORY_AND_THERMAL_REPORT.json`, `EXECUTION_LOGS/`, `MODEL_HASHES.txt`, `DATASET_HASHES.txt`, `EVIDENCE_MANIFEST.sha256`, and `FINAL_REPORT.md`.
