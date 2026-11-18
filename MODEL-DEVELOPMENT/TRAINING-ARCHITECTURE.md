# Independent ASR Model Training & Evaluation Summary (Phase 4)

## 1. Execution Truth Notice
- `[Observed Fact]` Local container hardware profile is `G0_CPU_ONLY` (`Linux 4.19.0-gvisor x86_64`, `4 vCPUs`, PyTorch/CUDA absent).
- Full GPU LoRA/SFT runs for `M01..M05` (`training/configs/qwen3_asr_sft_v1.yaml`) are **not executed** in this container and remain `[BLOCKED_EXTERNAL_GPU]`.
- `M06` (`ASR-FA-EN-1.0.0-RC1`) runs deterministically on `G0_CPU_ONLY` with checkpoint save/resume (`k > 0`), rollback, deterministic train-only augmentation (`A00..A05`), 70/30 hard-example sampling, and 3-layer output separation (`raw_model_output`, `normalized_text`, `domain_adapted_text`).

## 2. Three-Tier Transcript & Validation Rules
1. `text_raw`: Preserves exact spoken colloquial forms and pause markers.
2. `text_normalized`: Standardizes ZWNJ, Arabic Yeh/Kaf, punctuation, and numerals under `FA-RELAXED-V1`.
3. `text_training`: Cleaned alignment target after validation-only leak checks.
4. Validation and holdout manifests (`training/data/validation_manifest.jsonl`, `training/data/final_test_manifest.jsonl`) strictly enforce **speaker-disjoint** separation and **zero augmentation leakage**.
