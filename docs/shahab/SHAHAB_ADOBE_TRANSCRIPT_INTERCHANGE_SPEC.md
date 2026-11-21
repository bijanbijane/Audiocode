# Adobe Audition Transcript Interchange Specification (SHAHAB-024)

1. **Audition Markers CSV (Tab-Delimited, UTF-8 BOM):** `Name\tStart\tDuration\tTime Format\tType\tDescription` with `decimal` time format and `Cue` type for direct `File > Import > Markers from File`.
2. **SRT (UTF-8):** Standard subtitle interchange preserving ZWNJ and Persian Unicode.
3. **Structured JSON Sidecar (`.shahab.json`):** Lossless provenance, 6-layer transcript record, and model/runtime identity.
