# Candidate Models Matrix (Phase 4 — M01..M06)

| Candidate | Repo / ID | Params | License (6-Part) | Persian Support | Code-Switch | Streaming Mode | Local `G0_CPU_ONLY` Status |
|---|---|---|---|---|---|---|---|
| `M01` | `Qwen/Qwen3-ASR-1.7B` | 1.7B | Apache-2.0 (`VERIFIED_PERMISSIVE`) | Native Multilingual | Strong Audio-LM | vLLM Chunked Reprocess | `[BLOCKED_REQUIRES_CUDA_GPU]` (>=16GB LoRA / >=40GB Full) |
| `M02` | `Qwen/Qwen3-ASR-0.6B` | 0.6B | Apache-2.0 (`VERIFIED_PERMISSIVE`) | Native Multilingual | Strong Audio-LM | vLLM Chunked Reprocess | `[BLOCKED_REQUIRES_CUDA_GPU]` (>=10GB LoRA / >=24GB Full) |
| `M03` | `openai/whisper-large-v3` | 1.55B | MIT (`VERIFIED_PERMISSIVE`) | Supported Lower Accuracy | Moderate Seq2Seq | Chunked Window Only | `[BLOCKED_REQUIRES_CUDA_GPU]` |
| `M04` | `openai/whisper-large-v3-turbo` | 809M | MIT (`VERIFIED_PERMISSIVE`) | Supported Lower Accuracy | Moderate Seq2Seq | Chunked Window Only | `[BLOCKED_REQUIRES_CUDA_GPU]` |
| `M05` | `nvidia/stt_en_fastconformer_hybrid_large_pc` | 114M | CC-BY-4.0 (`VERIFIED_WITH_ATTRIBUTION`) | Custom Tokenizer Needed | Limited CTC/RNNT | Native Frame Streaming | `[BLOCKED_REQUIRES_CUDA_GPU]` |
| `M06` | `avapardaz/asr-fa-en-rc1-cpu-adapter` | Local CPU Adapter | MIT (`VERIFIED_PERMISSIVE`) | Native FA/EN/AR | Bigram + Phonetic Rescoring | Native Frame + VAD Segmented | `[EXECUTABLE_IN_G0_CPU]` |
