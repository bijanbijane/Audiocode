# SHAHAB–Adobe Audition Official Integration Research (SHAHAB-024)

- **Primary Architecture Decision:** `COMPANION_APP_APPROVED`
- **Date Checked:** `2026-11-21`
- **Key Findings:**
  1. **VST3 / AU Plug-ins:** Officially supported for real-time audio DSP effects, but UNSUITABLE and REJECTED for ASR transcript generation (real-time callback safety + no transcript/marker creation API).
  2. **UXP Extension API:** **NOT SUPPORTED** in Adobe Audition (public UXP API exists for Photoshop/Premiere Pro, not Audition).
  3. **Native Speech-to-Text:** Exists in Premiere Pro, NOT inside Adobe Audition.
  4. **Markers Tab-Delimited CSV / WAV Cues:** **OFFICIALLY DOCUMENTED** (`File > Import > Markers from File` & `File > Export > Selected Markers as CSV`), making Companion App + Markers CSV + SRT + JSON Sidecar the cleanest officially supported, maintainable path.
