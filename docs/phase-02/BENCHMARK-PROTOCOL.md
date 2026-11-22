# AVAPARDAZ — PHASE-02: REPRODUCIBLE ASR BENCHMARK PROTOCOL

**Document ID:** `AVP-P02-PROTOCOL-2.0`  
**Execution ID:** `AVP-P02-001`  
**Date:** `2026-11-22`  
**Scripts in Repository:**
- `benchmarks/phase02/prepare_fleurs_dev_eval.py` (Licensed `CC-BY-4.0` FLEURS `dev` builder)
- `benchmarks/phase02/run_cpu_bakeoff.py` (5-model offline CPU accuracy/RTF/RSS/cold-start bake-off)
- `benchmarks/phase02/run_product_fit_benchmark.py` (Product-fit timestamp, repetition, silence hallucination, noise/tempo stress, thread-scaling, long-audio & 10x stability benchmark)
- `benchmarks/phase02/test_evaluation_metrics.py` (Unit tests for CER/WER/bootstrap CI metrics — `6/6 PASS`)

---

## 1. Mandatory Evaluation Metrics (12 / 12 Covered)

| # | Metric | Exact Measurement Method | Execution Script / Evidence |
| :-: | :--- | :--- | :--- |
| 1 | **Persian CER** | Character Error Rate (`Levenshtein(ref_chars, hyp_chars) / len(ref_chars)`) reported in BOTH **Raw** and **Normalized (`FA-RELAXED-V1`)** forms (Arabic/Persian ی/ک unification, ZWNJ/diacritics/punctuation normalization). | `run_cpu_bakeoff.py` + `training/scripts/evaluate_asr.py` |
| 2 | **Persian WER** | Word Error Rate (`Levenshtein(ref_words, hyp_words) / len(ref_words)`) in BOTH **Raw** and **Normalized (`FA-RELAXED-V1`)** forms. | `run_cpu_bakeoff.py` + `results-2026-11-20.json` |
| 3 | **English WER** | Lowercased, punctuation-stripped English Word Error Rate + Raw WER on `google/fleurs` (`en_us` `dev`). | `run_cpu_bakeoff.py` + `results-2026-11-20.json` |
| 4 | **Code-Switching** | Combined `CER` / `WER` + **Latin Token Recall** on real bilingual language-switch utterances (`fa-en-concat`: real FA + 350ms pause + real EN). Natural intra-sentence studio code-switching is explicitly tracked as a separate unmeasured condition until studio corpus acquisition. | `run_cpu_bakeoff.py` + `results-2026-11-20.json` |
| 5 | **RTF (Real-Time Factor)** | `decode_sec / audio_duration_sec` parsed directly from `sherpa-onnx-offline` native timing output (excluding cold-start init, which is measured separately; wall time also logged). Target: `< 1.0` on CPU (`< 0.3` preferred). | `run_cpu_bakeoff.py` & `run_product_fit_benchmark.py` |
| 6 | **RAM Peak (RSS)** | Isolated child-process `resource.getrusage(RUSAGE_CHILDREN).ru_maxrss` in MiB (both single-stream `1x` and chunked/batch runs). | `run_cpu_bakeoff.py` & `run_product_fit_benchmark.py` |
| 7 | **Cold Start Latency** | Exact `recognizer created in X s` parsed from `sherpa-onnx-offline` stderr on cold process launch (`ms`). | `run_cpu_bakeoff.py` & `run_product_fit_benchmark.py` |
| 8 | **CPU Utilization** | `(ru_utime + ru_stime) / wall_sec * 100%` measured per thread setting (`--num-threads=1, 2, 4`). | `run_product_fit_benchmark.py` |
| 9 | **Timestamp Accuracy** | Two checks: (a) native word/token timestamp emission capability (`WORD` vs `SEGMENT`); (b) controlled acoustic offset probe injecting exact `+2.000s` leading silence and `+2.500s` internal pause on real Persian speech and measuring exact onset timestamp error in `ms`. | `run_product_fit_benchmark.py` |
| 10 | **Long Audio Stability** | `300s` (5-minute) chunked streaming execution (`12 × 25s` chunks) verifying `O(1)` Peak RSS (drift `MiB`), consistent RTF, `0` crashes, and deterministic token counts across all chunks. | `run_product_fit_benchmark.py` |
| 11 | **Offline Isolation** | Strict child-process network blackholing (`http_proxy=http://127.0.0.1:9`, `https_proxy=http://127.0.0.1:9`, `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`) asserting `rc == 0` and `100%` output completion with zero external requests. | Both scripts (`enforce_offline_env=True`) |
| 12 | **Sequential Stability** | `10` consecutive cold-process offline runs asserting `10/10` exit code `0`, `100%` deterministic transcript identity, and bounded RSS variance. | `run_product_fit_benchmark.py` |

---

## 2. Product-Specific Audio-Editing Evaluation Protocol (Section 6)

Because AVAPARDAZ is a **Smart Audio Editor** (not a generic captioning tool), low WER alone is insufficient. Every candidate must be tested on editing-critical behaviors:

1. **Verbatim Repetition Preservation:** Duplicate a real Persian spoken utterance back-to-back with a `250 ms` pause. The ASR model **must output both occurrences verbatim** so Engine 02 (Smart Edit Decision) can detect and propose deleting the unwanted take. Autoregressive LLMs/encoders that silently "clean up" repetitions break audio editing.
2. **Silence & Room-Noise Hallucination Test:** Feed `10.0s` of pure digital silence (`0x0000`) and `10.0s` of `-45 dBFS` synthetic room floor noise. Any hallucinated phantom words risk corrupting edit boundaries or masking true silence pauses.
3. **Acoustic Stress Robustness:** Measure CER drift relative to clean baseline under `15 dB` SNR noise, `8 dB` SNR noise, `0.85×` slow speech, and `1.20×` fast speech (`ffmpeg atempo`).
4. **Word-Level Timestamp Granularity & Onset Precision:** Verify whether timestamps are emitted natively at token/word granularity (`< 100 ms` onset error target) vs coarse 30s segments.
5. **Chunk Boundary Integrity:** Verify `25s` chunking with energy-valley boundary selection + `1.5s` overlap deduplication does not systematically lose or duplicate words at seams.

---

## 3. Statistical Significance & Anti-Cherry-Picking Rules

- **Paired Bootstrap Confidence Intervals:** Every head-to-head model comparison uses `2,000` paired bootstrap resamples (`seed=42`, `95% CI`) over the exact same utterance IDs (`training/scripts/evaluate_asr.py`).
- **Frozen Test Hygiene:** `google/fleurs` `test` split and `ArmanJR/PESTE-Benchmark` (`871` clips) are strictly untouched during `PHASE-02`. Only `google/fleurs` `dev` split (`CC-BY-4.0`) and bundled Apache-2.0 sample WAVs are used.
- **Zero Mixing of Provenance:** Real speech, concatenated bilingual pairs, and controlled acoustic stress perturbations (noise/tempo/silence-offset) are logged under separate schema keys and never pooled into a single misleading average.
- **Exact Artifact Provenance:** Every model file and evaluation WAV is hashed with `SHA-256` before execution.

---

## 4. Reproducibility Commands

```bash
# 1. Verify evaluation metrics & bootstrap CI math (6 unit tests)
python3 -m unittest benchmarks/phase02/test_evaluation_metrics.py

# 2. Run product-fit, timestamp, repetition, silence, noise/tempo, thread-scaling,
#    5-minute long-audio & 10x stability benchmark on local CPU
python3 benchmarks/phase02/run_product_fit_benchmark.py

# 3. Inspect full 5-model FLEURS dev bake-off raw evidence
ls -lh benchmarks/phase02/results-2026-11-20.json
```
