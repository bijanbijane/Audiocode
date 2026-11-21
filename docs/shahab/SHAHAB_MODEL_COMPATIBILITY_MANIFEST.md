# SHAHAB Model Artifact Compatibility Manifest

| File | Opset | Inputs | Outputs | Operators |
|---|---|---|---|---|
| encoder.int8.onnx | opset 14 | x, x_lens | encoder_out, encoder_out_lens | 4445 (33 unique) |
| decoder.int8.onnx | opset 14 | y | decoder_out | 14 (11 unique) |
| joiner.int8.onnx | opset 14 | encoder_out, decoder_out | logit | 8 (6 unique) |
