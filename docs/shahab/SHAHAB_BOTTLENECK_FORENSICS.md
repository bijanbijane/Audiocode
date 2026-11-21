# SHAHAB Bottleneck Forensics (Amdahl Decomposition)

| Stage | Median Latency | Share of Total | Amdahl Max Speedup | Opt Potential | Source |
|---|---:|---:|---:|---|---|
| Zipformer INT8 Encoder (ONNX WASM CPU) | 744 ms | 77.44% | 4.43x | LOW_RUNTIME_BOUND | `src/shahab/ShahabZipformerEngine.ts::encodeAudio` |
| RNN-T Decoder + Joiner Beam Search | 174 ms | 18.11% | 1.22x | MEDIUM | `src/shahab/ShahabZipformerEngine.ts::decodeFromEncoderOutput` |
| Kaldi 80-dim FBANK Feature Extraction | 52.495 ms | 5.46% | 1.06x | HIGH | `src/shahab/ShahabZipformerEngine.ts::extractKaldiFbank80` |
