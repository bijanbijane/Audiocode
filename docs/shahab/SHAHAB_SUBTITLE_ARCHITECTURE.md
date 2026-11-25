# SHAHAB-027 Professional Subtitle & Caption Architecture

- **Contract Version:** `1.0.0`
- **Service Module:** `src/shahab/ShahabSubtitleEngine.ts`
- **Modes:** `VERBATIM`, `CLEANED` (reversible transformation log), `ACCESSIBILITY` (verified/annotated non-speech cues only).
- **Dependency Lineage:** Every subtitle document tracks exact `audioSha256`, `transcriptRevisionId`, `alignmentRequestId`, `alignmentGranularity`, and `diarizationRevisionId`.
