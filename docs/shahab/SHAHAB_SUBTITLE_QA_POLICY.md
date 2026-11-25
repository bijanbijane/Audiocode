# SHAHAB-027 Automated Subtitle QA Policy

Audits 4 categories without silently rewriting text:
1. `STRUCTURAL` (empty cues, line count, line grapheme width)
2. `TIMING` (negative duration, min/max duration, undeclared overlaps, out-of-media-range, tight gaps)
3. `READABILITY` (CPS ceiling violations)
4. `PERSIAN_LINGUISTIC` (broken ZWNJ after `می/نمی`, detached punctuation, RTL mixed-script risks)
