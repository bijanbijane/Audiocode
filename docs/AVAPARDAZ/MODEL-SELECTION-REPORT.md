# AVAPARDAZ — PHASE-02: EVIDENCE-BASED ASR MODEL SELECTION REPORT

**Document ID:** `AVP-P02-MODEL-SELECT-1.0`  
**Execution ID:** `AVP-P02-001`  
**Date:** `2026-11-20`  
**Raw Machine-Readable Evidence:** `benchmarks/phase02/results-2026-11-20.json` (`90,250 bytes`)  
**Evaluation Corpus:** `25` real `CC-BY-4.0` Google FLEURS `dev` audio files (`277.33s` total: `10` Persian `fa_ir`, `10` English `en_us`, `5` Bilingual `fa-en-concat`)  
**Runtime & Host:** `sherpa-onnx` `v2.0.2` (`Apache-2.0`), Linux `x86_64`, 4 vCPUs, 12 GiB RAM (`G0_CPU_ONLY`), strict offline proxy-blackhole isolation (`http_proxy=127.0.0.1:9`, `HF_HUB_OFFLINE=1`).

---

## 1. Complete 5-Model Real CPU Benchmark Matrix (`25 / 25` Real Audio Files, `rc=0`)

| Model ID | License | Disk (`MiB`) | Offline | Cold Start (`ms`) | Peak RSS 1x (`MiB`) | Overall `RTF` | **FA Norm CER** (Raw) | **EN Norm WER** | **CS Norm CER** | **CS Latin Recall** | Word Timestamps |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`Reza2kn/Shenava-Rizeh`** *(NeMo FastConformer CTC INT8)* | `Apache-2.0` | **`36.43`** | `PASS` | `2,128` | **`165.81`** | **`0.0360`** (`27.8×` RT) | **`5.71%`** (`7.58%`) | `100.00%` *(FA-only)* | `65.23%` | `0.00%` | **YES (Native)** |
| **`openai/whisper-large-v3-turbo-int8`** | `MIT` | `988.59` | `PASS` | `7,519` | `1,382.88` | **`0.6121`** (`1.63×` RT) | **`7.71%`** (`8.71%`) | **`5.83%`** | `63.90%` | `17.50%` | NO (`SEGMENT`) |
| **`openai/whisper-base-fp32`** | `MIT` | `278.90` | `PASS` | `2,732` | `526.31` | `0.2372` (`4.22×` RT) | `29.57%` (`32.87%`) | `12.56%` | `73.75%` | `5.00%` | NO (`SEGMENT`) |
| **`openai/whisper-base-int8`** | `MIT` | `153.17` | `PASS` | `1,882` | `326.68` | `0.2314` (`4.32×` RT) | `44.57%` (`46.91%`) | `13.00%` | `78.52%` | `0.00%` | NO (`SEGMENT`) |
| **`Qwen/Qwen3-ASR-0.6B-int8`** | `Apache-2.0` | `941.28` | `PASS` | `11,612` | `1,588.21` | `0.9970` (`1.00×` RT) | `56.57%` (`56.60%`) | `13.00%` | **`48.06%`** | **`72.01%`** | NO (`SEGMENT`) |

---

## 2. Paired Bootstrap Statistical Significance (`2,000` Resamples, `seed=42`, `95% CI`)

*Negative delta = Candidate has LOWER error rate (better) than Baseline.*

| Subset | Metric | Candidate vs Baseline | Delta (`pp`) | `95% CI` (`pp`) | Statistically Significant? |
| :--- | :--- | :--- | :---: | :---: | :---: |
| `fa` | `norm_cer` | `Shenava-Rizeh` vs `whisper-base-fp32` | **`-23.86`** | `[-29.20, -19.01]` | **YES** |
| `fa` | `norm_cer` | `Shenava-Rizeh` vs `whisper-large-v3-turbo-int8` | **`-2.00`** | `[-4.62, +0.86]` | No (near-tie; Shenava `17×` faster & `27×` smaller!) |
| `fa` | `norm_cer` | `whisper-large-v3-turbo-int8` vs `whisper-base-fp32` | **`-21.86`** | `[-26.59, -17.30]` | **YES** |
| `fa` | `norm_cer` | `whisper-base-int8` vs `whisper-base-fp32` | **`+15.00`** | `[+0.74, +34.22]` | **YES (Severe Quantization Regression!)** |
| `fa` | `norm_cer` | `whisper-large-v3-turbo-int8` vs `Qwen3-ASR-0.6B-int8` | **`-48.86`** | `[-77.33, -21.30]` | **YES** |
| `en` | `norm_wer` | `whisper-large-v3-turbo-int8` vs `whisper-base-fp32` | **`-6.73`** | `[-11.54, -2.20]` | **YES** |
| `en` | `norm_wer` | `whisper-large-v3-turbo-int8` vs `Qwen3-ASR-0.6B-int8` | **`-7.17`** | `[-15.93, -0.44]` | **YES** |
| `fa-en-concat` | `norm_cer` | `whisper-large-v3-turbo-int8` vs `Qwen3-ASR-0.6B-int8` | `+15.84` | `[-9.79, +39.15]` | No (wide variance due to Whisper language-lock) |

---

## 3. Three Critical Empirical Discoveries (Why Real Benchmarking Matters)

1. **`Qwen3-ASR-0.6B INT8` Fails Zero-Shot Persian (`56.57%` CER):** Despite strong English (`13.00%` WER) and high Latin recall (`72.01%`), zero-shot `Qwen3-ASR-0.6B-int8` transliterates Persian audio into phonetic Turkish/Latin script (`"Bistere doğranen zengin İkhanavadeyi Yahudi..."`), consumes `1,588 MiB` RSS, takes `11.6s` cold start, and runs at `RTF = 0.997`. **Verdict: REJECTED as zero-shot Persian base; reconsider ONLY after GPU Persian fine-tuning (`PHASE-06`).**
2. **Dynamic INT8 Quantization Destroys Small Multilingual Whisper Persian (`+15.00 pp` CER Regression):** `whisper-base-int8` degraded Persian CER from `29.57%` to `44.57%` (`95% CI [+0.74, +34.22]`) while delivering only `2.45%` CPU speedup (`RTF 0.237 -> 0.231`). **Verdict: REJECTED.**
3. **Bilingual Code-Switching Language-Lock Gap:** On 16–21s concatenated Persian+English utterances, `Whisper large-v3-turbo` locked onto the opening language (dropping the second language or translating Persian into English, yielding `CS_CER = 63.90%`). Seamless intra-sentence Persian+English code-switching requires **VAD/LID segmentation + GPU-backed bilingual fine-tuning (`PHASE-06`)**.

---

## 4. Final Base Model Selection & Profile Assignments (`ADR-023`)

| Product Profile | Assigned Model | Target Hardware / Product | Role & Justification |
| :--- | :--- | :--- | :--- |
| **`AVP_MODEL_LITE`** | **`Reza2kn/Shenava-Rizeh v1.0`** *(NeMo FastConformer CTC INT8, `36.43 MiB`, `Apache-2.0`)* | `TIER-0..3` Native Companion **&** Browser WASM (`onnxruntime-web`) | **Primary Persian Engine:** `5.71%` FA Norm CER, `27.8×` faster than real-time (`RTF 0.036`), `165.8 MiB` RSS, native word timestamps, fits mobile & desktop browsers. |
| **`AVP_MODEL_BALANCED`** | **Hybrid Language-Routed Profile:** `Shenava-Rizeh` (when `lang=fa`) + `Whisper large-v3-turbo INT8` (when `lang=en/auto`) | `TIER-1..2` (`8–16 GB` RAM Native Companion) | Delivers best-in-class Persian (`5.71%` CER, `0.036` RTF) AND best-in-class English (`5.83%` WER, `0.612` RTF) through one `sherpa-onnx` binary while avoiding `whisper-base` accuracy penalties. |
| **`AVP_MODEL_QUALITY`** | **`openai/whisper-large-v3-turbo-int8`** *(`988.59 MiB`, `MIT`)* — upgrade path: GPU-fine-tuned bilingual checkpoint (`PHASE-06`) | `TIER-2..3` (`16+ GB` RAM Native Companion) | Best single multilingual checkpoint (`7.71%` FA CER, `5.83%` EN WER, `1.63×` real-time on 4-core CPU). |
