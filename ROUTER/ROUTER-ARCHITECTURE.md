# Adaptive ASR Router Architecture & Limitations (Phase 6)

## Architecture Overview
1. **Engine Registry:** Tracks `asr_fa_en_v1`, `avapardaz_acoustic_raw_local`, `qwen3_asr_1_7b_vllm`, `whisper_large_v3_turbo_worker`, `gemini_audio_asr`, `elevenlabs_scribe_v3`, `deepgram_nova_3`, `openai_gpt_transcribe`.
2. **Audio Profiler (`audio_profile_v1`):** Computes duration, RMS dBFS, SNR estimate, clipping ratio, and probabilistic `dominant_persian` / `dominant_english` / `mixed_language` / `uncertain` classification locally without network calls.
3. **18-Gate Eligibility Filter:** Hard enforces `local_only`, `native_streaming`, `max_cost`, `max_latency_ms`, `unknown_cost`, and `tenant_isolation`, recording exact rejection codes per engine.
4. **Cascade Rule (`disagreement_only: false`):** Low-confidence or mixed-code-switch hypotheses can escalate even when disagreement metrics are absent, guarded by Circuit Breaker and Atomic Transactional Budget reservations (`Reserved + Consumed <= Approved Budget`).
5. **Known Limitation:** Circuit breaker and budget reservation ledgers are stored in-process memory in this single-node deployment (`IN_MEMORY_SUBSTITUTION_FOR_PG_REDIS`). External cloud/GPU routes fail closed unless credentials or workers are configured.
