# Baseline Comparison & Release Candidate Notes (Phase 4)

- **Release Candidate:** `ASR-FA-EN-1.0.0-RC1`
- **Truth Status:** `PARTIAL` (Local G0 CPU contextual bigram/phonetic adapter & 3-layer post-processor verified; GPU 1.7B weights pending G1/G2 CUDA run).
- **Legal & License Attribution:** All open-weight models (`M01..M05`) audited across 6 license layers (Weights, Architecture Code, Tokenizer, Training Scripts, Dataset, Commercial Derivative Rights) — zero GPL/AGPL/NC restrictions. Notice retained for `CC-BY-4.0` datasets.
- **Promotion Gate:** Requires positive relative CER improvement over `ASR-FA-EN-0.9.0-BASELINE`, zero ZWNJ regression, and full checkpoint rollback integrity (`steps k > 0 -> rollback`).
