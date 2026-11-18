# COST AND LATENCY BENCHMARK REPORT — PHASE 3

**Document Version:** `1.0.0-phase3`  
**Audit Date:** `2026-11-18`

---

## 1. Three-Tier Cost Accounting (`actual_cost`, `estimated_cost`, `unknown_cost`)

Per Phase 3 Section 9, every experiment run categorizes cost into one of three strict epistemic states:

| Engine ID | Billing Unit | Rate (USD) | Cost for 100 Hours Audio | Cost Origin Tier in Local G0 Run |
| :--- | :--- | :--- | :--- | :--- |
| `avapardaz_ctc_viterbi_local` | In-Process CPU | `$0.00 / min` | `$0.00` | `actual_cost` (`$0.000000` verified) |
| `avapardaz_acoustic_raw_local` | In-Process CPU | `$0.00 / min` | `$0.00` | `actual_cost` (`$0.000000` verified) |
| `elevenlabs_scribe_v3` | Per Audio Second | `$0.00667 / min` (`$0.40 / hr`) | `$40.00` | `estimated_cost` (`$0.005712` for `51.4s` corpus) |
| `openai_gpt_transcribe` | Per Audio Minute | `$0.00600 / min` (`$0.36 / hr`) | `$36.00` | `estimated_cost` (`$0.005140` for `51.4s` corpus) |
| `deepgram_nova_3` | Per Audio Second | `$0.00430 / min` (`$0.258 / hr`) | `$25.80` | `estimated_cost` (`$0.003684` for `51.4s` corpus) |
| `google_chirp_3` | Per Audio Second | `$0.01600 / min` (`$0.96 / hr`) | `$96.00` | `estimated_cost` (`$0.013707` for `51.4s` corpus) |
| `qwen3_asr_1_7b` | Self-Hosted GPU Hour | Uncalibrated GPU Lease | Depends on GPU utilization | `unknown_cost` (Until live GPU node billing rate is pinned) |

---

## 2. Verified Local Processing Latency & Real-Time Factor (`RTF`)

Measured across the 6 golden samples (`51.4s` total audio) on `4 vCPU` container (`G0_CPU_ONLY`):

| Engine ID | P50 Latency (ms) | P90 Latency (ms) | P95 Latency (ms) | P99 Latency (ms) | Mean RTF |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `avapardaz_ctc_viterbi_local` | `3.8 ms` | `6.1 ms` | `7.4 ms` | `8.9 ms` | `0.00045` |
| `avapardaz_acoustic_raw_local` | `2.4 ms` | `4.2 ms` | `5.0 ms` | `6.1 ms` | `0.00028` |
