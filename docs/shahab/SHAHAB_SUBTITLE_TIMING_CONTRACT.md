# SHAHAB-027 Subtitle Timing Contract (5 Separated Domains)

Every cue explicitly separates:
1. `acousticRange` — immutable source acoustic span from SHAHAB-025.
2. `displayRange` — viewer readability start/end with min-duration and gap enforcement.
3. `sourceRange` — original media sample coordinates.
4. `timelineRange` — editing timeline coordinates + exact Avapardaz flicks (`705,600,000 flicks/sec`).
5. `exportRange` — format/FPS quantized export timecodes.
