# SHAHAB-029 — Transcript-Aware Editorial Intelligence & Edit Decision Planning

- **Contract Version:** `1.0.0` | **EDP Schema:** `1.0.0`
- **Role in 3-Stage Architecture:** **DECIDE / PLAN ONLY** (Stage 2 of `Detect != Decide != Execute`). Never modifies source PCM or raw transcripts; emits immutable versioned Edit Decision Plans (EDP) bound to source SHA-256 and sample coordinates.
- **Profiles:** 9 versioned profiles (VERBATIM_PRESERVATION, LIGHT_CLEANUP, CONVERSATIONAL_CLEANUP, PODCAST_EDITING, INTERVIEW_EDITING, LECTURE_EDITING, PRESENTATION_EDITING, ARCHIVAL_PRESERVATION, CUSTOM_USER_POLICY) with conservative preservation defaults.
- **Persian Safeguards:** Separates isolated hesitations (`ام`, `اِ`, `آه`) from context-sensitive discourse markers (`یعنی`, `خب`, `حالا`) and protects Persian rhetorical reduplications (`خیلی خیلی`, `آرام آرام`).
- **Sample Plan:** `edp_92fda99fe0` rev `6` — 7 candidates, 3 approved cuts, 1 rejected, 1 protected ranges, 0 conflicts.
