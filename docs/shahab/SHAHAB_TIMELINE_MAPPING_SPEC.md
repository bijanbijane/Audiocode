# SHAHAB–Avapardaz Timeline Mapping Specification (SHAHAB-023)

- **Timebase:** Exact Avapardaz flicks (`705,600,000 flicks/sec`) and integer sample indices.
- **Distinct Domains:** Source-media samples, SHAHAB 16k processing samples, clip-local offsets, and project timeline flicks.
- **Time-Stretch Guard:** Non-1.0 playback-rate or time-stretched clips report `MAPPING_UNAVAILABLE_TIME_STRETCHED` instead of fabricating linear ratios.
