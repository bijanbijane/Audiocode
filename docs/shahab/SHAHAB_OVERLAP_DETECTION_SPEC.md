# SHAHAB-026 Overlapping Speech Specification

- Overlapping intervals are preserved explicitly with `kind: "OVERLAPPING_SPEECH"` and `activeSpeakerIds: string[]`.
- Concurrent speakers are NEVER forced into a fabricated sequential single-speaker timeline.
- Source separation is explicitly `NOT_SUPPORTED`.
