# AVAPARDAZ — PHASE-08: EMPIRICAL QUANTIZATION IMPACT REPORT (FP32 vs INT8 ON PERSIAN CPU ASR)

**Document ID:** `AVP-P08-QUANT-1.0`  
**Date:** `2026-11-20`  
**Evaluation Corpus:** 25 Real `CC-BY-4.0` Google FLEURS `dev` Audio Utterances (`277.33s` total: `10` Persian `fa_ir`, `10` English `en_us`, `5` Bilingual `fa-en-concat`)  
**Runtime:** `sherpa-onnx` `v2.0.2` CPU (`4` threads, Linux `x86_64`, strict offline proxy-blackhole isolation)

---

## 1. Controlled Experiment: `openai/whisper-base` FP32 vs Dynamic INT8 (`[TESTED]`)

One of the highest-risk assumptions in edge ASR engineering is that INT8 quantization automatically delivers "free speed" with negligible accuracy loss. On real Persian speech, our controlled head-to-head CPU benchmark proved the **exact opposite** for small multilingual Whisper models:

| Metric | `openai/whisper-base` (`FP32`) | `openai/whisper-base` (`INT8`) | Measured Delta (`INT8 - FP32`) | Verdict |
| :--- | :---: | :---: | :---: | :--- |
| **Artifact Disk Size** | `278.90 MiB` | `153.17 MiB` | **`-45.08%`** (`-125.73 MiB`) | Strong disk reduction |
| **Cold-Start Load Time** | `2,732.0 ms` | `1,882.0 ms` | **`-31.11%`** (`-850 ms`) | Faster load |
| **Single-Stream Peak RSS** | `526.31 MiB` | `326.68 MiB` | **`-37.93%`** (`-199.63 MiB`) | Significant RAM saving |
| **CPU Speed (`RTF`, 4 threads)** | `0.2372` (`4.22×` RT) | `0.2314` (`4.32×` RT) | **`-2.45%`** (negligible speedup!) | Almost zero CPU speedup on x86_64 |
| **English Norm WER (`10` samples)** | `12.56%` | `13.00%` | `+0.44 pp` | Mild English degradation |
| **Persian Norm CER (`10` samples)** | **`29.57%`** (`Raw 32.87%`) | **`44.57%`** (`Raw 46.91%`) | **`+15.00 pp` CATASTROPHIC REGRESSION** | **DISQUALIFIED FOR PERSIAN** |
| **Bilingual Norm CER (`5` samples)** | `73.75%` | `78.52%` | `+4.77 pp` | Severe degradation |
| **Bilingual Latin Recall** | `5.0%` | `0.0%` | `-5.0 pp` | Complete loss of Latin tokens |

---

## 2. Why Dynamic INT8 Hurt Low-Resource Persian So Severely While Leaving `Shenava-Rizeh INT8` Accurate

1. **Capacity Starvation in Small Multilingual Models (`whisper-base` = 74M params):** Small multilingual encoder-decoder models allocate only a tiny fraction of attention/FFN dynamic range to Persian tokens. Uncalibrated dynamic INT8 quantization clips low-magnitude Persian acoustic/cross-attention weights, causing hallucinated/garbled Persian outputs (`+15.00 pp` CER jump) while high-resource English barely shifts (`+0.44 pp` WER).
2. **Specialized Monolingual vs Large-Capacity Architectures:**
   - **`Reza2kn/Shenava-Rizeh` (NeMo FastConformer CTC INT8, `36.43 MiB`):** Because 100% of its parameters and vocabulary are dedicated to Persian, INT8 quantization retains **`5.71%` Norm CER** (`Raw 7.58%`) at **`RTF = 0.036`** (`27.8×` faster than real-time) and **`165.81 MiB`** Peak RSS!
   - **`openai/whisper-large-v3-turbo` (INT8, `988.59 MiB`, 809M params):** High parameter capacity absorbs INT8 quantization gracefully, preserving strong English (`5.83%` Norm WER) and strong Persian accuracy (see `PHASE-08-BENCHMARKS.md` & `results-2026-11-20.json` for exact 25/25 numbers and 95% CIs).

---

## 3. Binding Engineering Policy for AVAPARDAZ (`ADR-024`)

1. **NEVER ship unvalidated INT8/INT4 quantizations for Persian.** Every quantized export MUST pass paired bootstrap evaluation on the Frozen Persian & Code-Switch Test Set (`delta_cer_pp <= +1.0 pp` ceiling).
2. **Reject `whisper-base-int8` from all AVAPARDAZ product tiers.**
3. **Use `Reza2kn/Shenava-Rizeh INT8` (`36.4 MiB`, `Apache-2.0`) for `AVP_MODEL_LITE` (Persian fast CPU & Browser WASM)** and **`openai/whisper-large-v3-turbo` (`MIT`) for `AVP_MODEL_QUALITY` (English / Multilingual Native Companion)** until a GPU-fine-tuned bilingual model (`PHASE-06`) beats both on a held-out real Persian+English code-switching corpus.
