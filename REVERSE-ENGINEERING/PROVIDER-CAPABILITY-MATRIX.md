# PROVIDER CAPABILITY MATRIX — PHASE 3 VERIFIED INVENTORY

**Document Version:** `1.0.0-phase3`  
**Audit Date:** `2026-11-18`  
**Hardware Profile:** `G0_CPU_ONLY` (`4 vCPUs`, `12 GiB RAM`, `0 Local GPU`)

---

## 1. Capability & Operational Matrix Across All 13 Registered ASR Engines

| Engine ID | Provider | Deployment | Persian (`fa`) | English (`en`) | Code-Switching (`fa-en`) | Native Streaming | Word Timestamps | Speaker Diarization | Pricing Model | Local G0 Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `avapardaz_ctc_viterbi_local` | Avapardaz Lab | Local CPU In-Process | Native (ZWNJ + Homophone Rescorer) | Supported (Tech Lexicon) | Strong (Contextual Prefix Trie) | Frame-Level CTC | 20ms CTC Viterbi + Character Spans | Energy + Pitch Turn Detector | `$0.00` (Free Local) | `READY_LOCAL` |
| `avapardaz_acoustic_raw_local` | Avapardaz Lab | Local CPU In-Process | Supported (Unbiased Acoustic) | Supported (Phonetic) | Moderate (No Trie Bias) | Frame-Level CTC | 20ms Frame Boundaries | Basic Turn Detector | `$0.00` (Free Local) | `READY_LOCAL` |
| `elevenlabs_scribe_v3` | ElevenLabs | Cloud REST API | Native (90+ Langs) | Native | Strong | Batch REST | Character & Word + Audio Events | Up to 32 Speakers | `$0.40 / hour` (`$0.00667 / min`) | `REQUIRES_API_KEY` |
| `elevenlabs_scribe_v3_live` | ElevenLabs | Cloud WebSocket | Native | Native | Strong | WebSocket Live | Segment & Word | Supported | `$0.40 / hour` | `REQUIRES_API_KEY` |
| `openai_gpt_transcribe` | OpenAI | Cloud REST API | Supported | Native | Strong (Audio-LLM) | Batch REST | Segment Level | Prompt/Segment Based | `$0.006 / min` | `REQUIRES_API_KEY` |
| `openai_gpt_live_transcribe` | OpenAI | Cloud WebSocket | Supported | Native | Strong | Realtime WebSocket | Segment Level | Supported | `$0.006 / min` | `REQUIRES_API_KEY` |
| `deepgram_nova_3` | Deepgram | Cloud REST / WS | Unsupported Officially | Native (`<150ms`) | English-Centric | Native WebSocket | Word-Level + Keyterm Boost | Multi-Speaker | `$0.0043 / min` (Batch) / `$0.0059 / min` (Live) | `REQUIRES_API_KEY` |
| `google_chirp_3` | Google Cloud | Cloud V2 API | Native (`fa-IR`) | Native (`en-US`) | Moderate | gRPC / REST | Word-Level | Speaker Diarization | `$0.016 / min` | `REQUIRES_API_KEY` |
| `azure_ai_speech` | Microsoft Azure | Cloud SDK / REST | Native (`fa-IR`) | Native | Moderate | WebSocket SDK | Word-Level | Conversation Transcriber | `$0.0167 / min` | `REQUIRES_API_KEY` |
| `qwen3_asr_1_7b` | Alibaba Qwen | Self-Hosted GPU (vLLM) | Native Multilingual | Native | Strong (Omni Audio-LM) | vLLM Chunked Reprocess | Requires External Aligner for `fa` | External Pipeline | GPU Compute (`~10.5 GB VRAM`) | `REQUIRES_CUDA_GPU` |
| `qwen3_asr_0_6b` | Alibaba Qwen | Self-Hosted GPU (vLLM) | Native Multilingual | Native | Strong | vLLM Chunked Reprocess | Official 0.6B Aligner Excludes `fa` | External Pipeline | GPU Compute (`~5.5 GB VRAM`) | `REQUIRES_CUDA_GPU` |
| `whisper_large_v3` | OpenAI (Open Weights) | Self-Hosted GPU | Supported (Higher CER on Colloquial) | Native | Moderate | Chunked Window | Cross-Attention DTW | External (`pyannote`) | GPU Compute (`~5.0 GB VRAM`) | `REQUIRES_CUDA_GPU` |
| `nemo_fastconformer_fa` | NVIDIA NeMo | Self-Hosted GPU | Requires Custom Persian Tokenizer | Native | Limited CTC | Native Cache-Aware Streaming | CTC Frame Alignment | NeMo Sortformer / MSDD | GPU Compute (`~2.5 GB VRAM`) | `REQUIRES_CUDA_GPU` |

---

## 2. Verification Policy
- Every capability listed above is cross-checked in `PHASE3_ENGINE_CAPABILITY_REGISTRY` (`/src/ai-engine/asr/AsrDatasetAndBehavioralBenchmarkEngine.ts`).
- No commercial cloud provider or GPU weight is ever mocked when its API key or CUDA runtime is absent.
