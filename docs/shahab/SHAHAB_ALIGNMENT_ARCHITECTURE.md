# SHAHAB-025 Acoustic Forced Alignment Architecture

- **Contract Version:** `1.0.0`
- **Service Module:** `src/shahab/ShahabAlignmentEngine.ts`
- **Capability Status:** `ALIGNMENT_PARTIALLY_SUPPORTED`
- **Separation of Concerns:** Forced Alignment is strictly decoupled from ASR (`ShahabZipformerEngine`), Diarization (`SHAHAB-026`), and Subtitles (`SHAHAB-027`). It never mutates the supplied transcript and never fabricates proportional word timestamps.
- **Supported Backends:** `CTC_VITERBI_LOGPROBS`, `TRANSDUCER_TOKEN_EMISSION_LATTICE`, `ACOUSTIC_VAD_ANCHORED_SEGMENT`, `TIMING_UNAVAILABLE_NO_ACOUSTIC_EVIDENCE`.
