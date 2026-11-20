# AVAPARDAZ — PHASE-02 Reproducible CPU ASR Bake-off (`benchmarks/phase02/`)

This directory contains the zero-dependency Python 3.11+ benchmark suite used in **`PHASE-02` (`AVP-P02-001`)** to evaluate real open-source ASR models on real, legally licensed (`CC-BY-4.0`) Persian, English, and Bilingual-Switch audio on CPU-only hardware.

## Scientific & Hygiene Guarantees
1. **Zero Weights Committed to Repo:** Model archives (`.tar.bz2`, `.onnx`) and FLEURS evaluation audio live strictly in `/tmp/avp-p02-bench/` during benchmarking and are never committed into the repository.
2. **Frozen Test Set Protection:** Only the `google/fleurs` **`dev`** split (`fa_ir` and `en_us`, `CC-BY-4.0`) is used here. The `test` split and `ArmanJR/PESTE-Benchmark` remain `100%` untouched.
3. **Dual Raw + Normalized Metrics:** `training/scripts/evaluate_asr.py` reports both **raw** and **normalized (`FA-RELAXED-V1` / `EN-NORM-V1`)** CER/WER plus Latin-token recall and paired 10,000-iteration bootstrap 95% confidence intervals.
4. **Real Child-Process Telemetry:** `run_cpu_bakeoff.py` invokes `sherpa-onnx-offline` (`v2.0.2`, Apache-2.0) in an isolated child process per model to measure real cold-start wall latency, decode seconds, Real-Time Factor (RTF), and OS Peak Process RSS (`resource.getrusage(RUSAGE_CHILDREN).ru_maxrss`).

## Reproducible Commands

```bash
# 1. Run metric & parser unit tests
python3 -m unittest benchmarks/phase02/test_evaluation_metrics.py -v

# 2. Prepare canonical 16 kHz Mono PCM16 WAV evaluation samples from FLEURS dev
python3 benchmarks/phase02/prepare_fleurs_dev_eval.py

# 3. Execute multi-model CPU bake-off (generates JSON report)
python3 benchmarks/phase02/run_cpu_bakeoff.py /tmp/avp-p02-bench/bench_config.json
```
