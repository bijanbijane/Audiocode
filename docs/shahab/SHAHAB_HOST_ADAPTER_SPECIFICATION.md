# SHAHAB Host Adapter Specification

Host adapters MUST consume `ShahabSdkEngine`, call `negotiateCapabilities` before submitting jobs, preserve transcript layers without silent rewriting, respect `SEGMENT_LEVEL` timing limits, and never import private inference tensors or bypass authorization boundaries.
