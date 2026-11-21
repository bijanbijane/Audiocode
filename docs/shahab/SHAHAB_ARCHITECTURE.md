# SHAHAB Architecture (Engine SHAHAB-R2.0.0-RELEASE-CANDIDATE)

- **Engine Release:** `SHAHAB-R2.0.0-RELEASE-CANDIDATE` (integrated from `SHAHAB-R1.4.0` & `SHAHAB-R1.5.0-VALIDATION`)
- **Neural Core Identity:** `INHERITED-PERSIAN-ASR-CORE` (`ramin-mahmoodi/persian-zipformer-asr` @ `0408facbcf3f670121def48e0802c395c225d150`, Apache-2.0, `trainable_parameters = 0`)
- **Unified Local/Cloud Pipeline:** 19-stage logical contract in `src/shahab/ShahabEngineUnified.ts`. Local mode never uploads audio; `AUTO` never silently escalates Local failures to Cloud.
- **Acoustic State Reuse:** 3-graph ONNX Zipformer-Transducer (`encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`) executes the Encoder once and reuses `encoder_out` across `SPEED`, `BALANCED`, `PRECISION`, `VOCABULARY`, and `VERBATIM` policies via `SHAHABEncoderOutputCache`.
- **Avapardaz Integration:** Reuses existing `P0-009` (`PersianLinguisticQualityEngine`), `P0-010` (`PersianEvidenceCorrectionEngine`), and `P0-012` (`PersianLexicalDisambiguationEngine`). Note: no standalone `P0-011` module exists in workspace.
- **Resilience & Recovery (SHAHAB-015):** 12 real fault-containment boundaries, 33-code typed failure taxonomy, 14-state crash-safe job state machine, SHA-256 checkpoint verification, bounded retry controller, Local/Cloud isolation guard, and verified backup/restore drills.
