# SHAHAB Decision Log

1. **Selected Neural Core:** `ramin-mahmoodi/persian-zipformer-asr` @ `0408facbcf3f670121def48e0802c395c225d150` (Apache-2.0, INT8 ONNX) — smallest permissive Persian Zipformer transducer runnable natively in `onnxruntime-web@1.31.1` WASM CPU.
2. **Nemotron Legal Gate:** `mehdi-hf/nemotron-asr-streaming-farsi` excluded from commercial distillation & production due to `license: other`.
3. **SHAHAB-011 Neural Independence Decision:** `CONTINUE_FROZEN_WEIGHT_RUNTIME` — pilot evidence (1 independent recording, 0 human review submissions, 0 GPUs) does NOT justify neural training.
4. **SHAHAB-012 Branch:** `NOT_REQUIRED_BY_EVIDENCE` — zero neural weight edits; `SHAHAB-Persian-ASR-0.1.0` intentionally NOT minted.
5. **SHAHAB-013 Branch:** `BRANCH_B_FROZEN_INHERITED_NEURAL_CORE_CONTINUES` — engine released as `SHAHAB-R2.0.0-RELEASE-CANDIDATE` with explicit inherited neural core identity.
6. **SHAHAB-014 Auto-Rollout Gate:** Automatic production rollout remains DISABLED until external Ed25519 release signing infrastructure is provisioned.
