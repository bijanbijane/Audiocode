# SHAHAB-027 Export Format Compatibility & Loss Accounting

| Format | Extension | Round-Trip Verified | ZWNJ Preserved | Declared Losses |
|---|---|---|---|---|
| `SRT_UTF8` | `.srt` | true | true | SRT has no native metadata for structured speaker IDs, acoustic vs. display timing separation, revision history, or dependency lineage. |
| `WEBVTT_UTF8` | `.vtt` | true | true | WebVTT drops full sample-index/flick timing domains, transformation provenance logs, and revision ancestry. |
| `TTML_XML` | `.ttml` | true | true | TTML preserves xml:lang="fa", tts:direction="rtl", and ttm:agent speaker references, but omits full SHAHAB sample/flick lineage and revision history. |
| `JSON_SIDECAR` | `.subtitle.shahab.json` | true | true | None (Lossless) |
