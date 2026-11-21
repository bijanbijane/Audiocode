---
language:
  - fa
tags:
  - speech-recognition
  - asr
  - sherpa-onnx
  - zipformer
  - transducer
  - onnx
  - int8
  - farsi
  - persian
license: apache-2.0
datasets:
  - mozilla-foundation/common_voice_17_0
  - google/fleurs
metrics:
  - wer
  - cer
pipeline_tag: automatic-speech-recognition
---

# 🎙️ Persian Zipformer-Transducer ASR (sherpa-onnx)

<p align="center">
  <img src="https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/master/.github/workflows/sherpa-logo.png" width="160" alt="sherpa-onnx logo"/>
</p>

<p align="center">
  <a href="https://huggingface.co/spaces/ramin-mahmoodi/persian-zipformer-asr-demo" target="_blank">
    <img src="https://huggingface.co/datasets/huggingface/badges/resolve/main/open-in-hf-spaces-lg.svg" alt="Open in Spaces"/>
  </a>
</p>


An ultra-efficient, production-grade Persian Automatic Speech Recognition (ASR) engine based on the state-of-the-art **Zipformer-Transducer** architecture (`pruned_transducer_stateless7`).

Trained on over **830+ hours** of high-quality Persian speech data (Common Voice 17.0, Google FLEURS, and Mana Persian Corpus) and exported to both **ONNX FP32** and optimized **INT8 Quantized** formats for blazing-fast inference on CPU, Mobile (Android / iOS), Raspberry Pi, and Edge servers.

---

## ⚡ Highlights

- **Ultra-Compact Footprint:** The complete INT8 quantized model package is only **~110 MB** (Encoder: 108 MB, Decoder: 1.7 MB, Joiner: 0.4 MB).
- **Blazing Fast Real-Time Factor (RTF):** Runs at **RTF < 0.05** on standard CPU (transcribes 10 seconds of speech in under 0.5s).
- **Zero Heavy Dependencies:** Fully powered by [`sherpa-onnx`](https://github.com/k2-fsa/sherpa-onnx). Does **not** require PyTorch, CUDA compilation, or heavy frameworks.
- **Persian Typography & ZWNJ Support:** Includes `PersianPostProcessor` for automatic half-space (نیم‌فاصله `\u200c`) restoration across prefixes (`می‌`), suffixes (`ها`, `تر`), and compound phrases.
- **Multi-Platform Deployment:** Drop-in compatibility with C++, Python, Android, iOS, Flutter, Node.js, and WebAssembly via Sherpa-ONNX.

---

## 📊 Evaluation & Benchmarks

All evaluations performed using `modified_beam_search` (`max_active_paths=4`):

| Test Set | Hours / Samples | WER (%) | CER (%) | Word Accuracy | Character Accuracy |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Mozilla Common Voice 17.0 (fa)** | 1,200+ utterances | **18.75%** | **5.05%** | **81.25%** | **94.95%** |
| **Google FLEURS (fa_ir)** | 871 utterances | **25.73%** | **5.82%** | **74.27%** | **94.18%** |
| **Studio Reading Corpus** | 2,000+ utterances | **5.30%** | **1.80%** | **94.70%** | **98.20%** |

*Note: INT8 quantization matches FP32 accuracy within 0.05% margin while reducing RAM footprint by ~60% and speeding up CPU inference by 35-40%.*

---

## 🚀 Quickstart & Installation

### 1. Install Sherpa-ONNX & Soundfile

```bash
pip install sherpa-onnx soundfile
```

### 2. Download Model Files

You can clone or download the repository:

```bash
git clone https://huggingface.co/ramin-mahmoodi/persian-zipformer-asr
cd persian-zipformer-asr
```

### 3. Run Inference via CLI

Transcribe the included sample audio (`sample.wav`):

```bash
python transcribe.py --audio sample.wav
```

Output:
```
Transcribing 'sample.wav' (Mode: INT8 Quantized)...

[Raw Output]:
شکلات داغ در حد استانداردهای بلژیکی است آبمیوهها گران قیمت ولی عالی میباشند

[Clean Persian Output (with ZWNJ / نیم‌فاصله)]:
شکلات داغ در حد استانداردهای بلژیکی است آبمیوه‌ها گران‌قیمت ولی عالی می‌باشند
```

---

## 💻 Python API Example

```python
import sherpa_onnx
import soundfile as sf
from transcribe import PersianPostProcessor

# 1. Initialize recognizer with INT8 models
recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
    encoder="encoder.int8.onnx",
    decoder="decoder.int8.onnx",
    joiner="joiner.int8.onnx",
    tokens="tokens.txt",
    num_threads=4,
    sample_rate=16000,
    feature_dim=80,
    decoding_method="modified_beam_search",
    max_active_paths=4,
)

# 2. Read 16kHz audio
audio, sample_rate = sf.read("sample.wav")

# 3. Transcribe
stream = recognizer.create_stream()
stream.accept_waveform(sample_rate, audio)
recognizer.decode_stream(stream)

# 4. Polish typography
post_processor = PersianPostProcessor()
result = post_processor.process(stream.result.text)

print("Transcription:", result)
```

---

## 🏗️ Architecture Details

- **Model Type:** `zipformer2` (`pruned_transducer_stateless7`)
- **Parameters:** ~65.3 Million
- **Audio Inputs:** 16,000 Hz, 80-dimensional log-mel filterbank (25ms window, 10ms frame shift)
- **Averaged Checkpoints:** Averaged weights of top 5 checkpoints (Steps 122.5k - 132.5k, Epoch 5)
- **Vocabulary:** 1,024 Persian subword units generated via SentencePiece (BPE)
- **Decoding Algorithm:** Modified Beam Search with path pruning

---

## 📱 Mobile & Edge Deployment (Sherpa-ONNX)

Because the model conforms to standard `sherpa-onnx` transducer specifications, it runs directly with official Sherpa-ONNX binaries:

### Using official `sherpa-onnx-offline` CLI:
```bash
sherpa-onnx-offline \
  --encoder=./encoder.int8.onnx \
  --decoder=./decoder.int8.onnx \
  --joiner=./joiner.int8.onnx \
  --tokens=./tokens.txt \
  --decoding-method=modified_beam_search \
  ./sample.wav
```

### Android / iOS:
Simply copy `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, and `tokens.txt` to your app assets folder and follow the [sherpa-onnx Android ASR tutorial](https://k2-fsa.github.io/sherpa/onnx/android/index.html).

---

## 📜 License & Citation

This model is licensed under the **Apache 2.0** License.

```bibtex
@misc{persian-zipformer-asr,
  author = {Ramin Mahmoodi},
  title = {Persian Zipformer-Transducer ASR Engine},
  year = {2026},
  publisher = {Hugging Face},
  howpublished = {\url{https://huggingface.co/ramin-mahmoodi/persian-zipformer-asr}}
}
```
