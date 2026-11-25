# SHAHAB-026 Speaker Diarization Architecture

- **Contract Version:** `1.0.0`
- **Service Module:** `src/shahab/ShahabDiarizationEngine.ts`
- **Capability Status:** `SEPARATE_DIARIZATION_MODEL_REQUIRED`
- **Strict Stage Separation:** VAD (`AVAILABLE_DETERMINISTIC_ENERGY_ZCR`), Speech Segmentation (`AVAILABLE_DETERMINISTIC_TURN_WINDOWING`), Diarization Clustering (`AVAILABLE_AHC_WITH_PLUGGABLE_EMBEDDING_PROVIDER`), Overlap Detection (`OVERLAP_DETECTION_EXPERIMENTAL_PROXY`), Speaker Separation (`NOT_SUPPORTED`), Speaker Identification (`PROHIBITED_BY_POLICY`).
