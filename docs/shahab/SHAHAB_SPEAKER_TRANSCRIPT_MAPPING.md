# SHAHAB-026 Speaker-to-Transcript Mapping Specification

- Explicit attribution granularities: `RECORDING_LEVEL`, `TURN_LEVEL`, `SEGMENT_LEVEL`, `WORD_LEVEL`.
- Refuses `WORD_LEVEL` attribution when SHAHAB-025 has not produced verified word-level alignment (`wordAttributionRefusedWithoutWordAlignment=true`).
- Preserves `OVERLAPPING_SPEECH` and `UNKNOWN_SPEAKER` on attributed transcript segments.
