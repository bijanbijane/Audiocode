# SHAHAB-027 Speaker-Aware Caption Policy

- Consumes verified SHAHAB-026 speaker attributions only; omits labels when diarization is absent.
- Preserves `OVERLAPPING_SPEECH` via dual-line dash prefixes (`- گوینده ۱: ...` / `- گوینده ۲: ...`) and `overlapFlag: true`.
- Never invents non-speech sound descriptions from transcript text; `ACCESSIBILITY` non-speech cues require `VERIFIED_AUDIO_DETECTOR` or `EXPLICIT_HUMAN_ANNOTATION`.
