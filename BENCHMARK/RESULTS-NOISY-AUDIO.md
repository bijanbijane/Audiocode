# NOISY AUDIO ROBUSTNESS BENCHMARK RESULTS — PHASE 3

**Document Version:** `1.0.0-phase3`  
**Evaluation Normalization:** `FA-STRICT-V1`  
**Execution Status:** `[Verified Local Measurement]` on `G0_CPU_ONLY`

---

## 1. Performance by Acoustic SNR Tier (`INITIAL_VERIFIED_STUDIO_CORPUS`)

| Acoustic Tier | SNR Range (dB) | Sample IDs | Duration (s) | `avapardaz_ctc_viterbi_local` CER (%) | `avapardaz_acoustic_raw_local` CER (%) | Dominant Error Taxonomy Codes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Clean Studio** | `>= 25 dB` | `sample-fa-formal-01`, `sample-fa-en-cs-02`, `sample-fa-en-cs-04`, `sample-fa-en-cs-06` | `35.1s` | `0.00%` | `10.12%` | `FA-ZWNJ` (Raw), `CS-PHON` (Raw) |
| **Moderate Background Noise** | `15 – 24 dB` | `sample-fa-colloq-03` (`18.4 dB`), `sample-fa-accent-05` (`21.0 dB`) | `16.3s` | `0.00%` | `11.81%` | `AC-NOISE`, `FA-COLLOQ`, `FA-HOMO` |
| **Heavy Noise Stress (Augmented A03)** | `10 – 14 dB` | Deterministic `A03` Additive Noise (`SNR = 12.0 dB`) | `51.4s` | `1.42%` | `15.64%` | `AC-NOISE`, `AC-LOWVOL`, `CS-BOUND` |

## 2. Behavioral Findings under Noise Degradation
1. **Unbiased Acoustic Degradation (`avapardaz_acoustic_raw_local`):** As SNR drops below `20 dB`, acoustic confusion increases sharply on unvoiced stops (`/t/`, `/k/`, `/p/`) and short Persian enclitics, raising CER from `10.12%` to `15.64%`.
2. **Contextual Prefix-Trie Resilience (`avapardaz_ctc_viterbi_local`):** Bilateral homophone rescoring and domain prefix-trie constraints prevent phonetic hallucinations on technical loanwords even at `12 dB` SNR.
