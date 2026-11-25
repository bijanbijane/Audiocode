# SHAHAB-025 Persian Alignment Text Preparation Policy

- **Policy Version:** `persian-align-norm-1.0.0`
- **Reversibility:** Every prepared token stores `originalCharStart` and `originalCharEnd` verified against `originalText.slice(start, end) === originalSurface`.
- **Orthography:** Maps Arabic Yeh/Kaf to Persian Yeh/Kaf strictly inside the derived alignment form without modifying the source transcript. Preserves ZWNJ (`\u200c`) inside Persian compound words (`PERSIAN_COMPOUND_ZWNJ`).
- **Numerals & Mixed Script:** Numeric literals without verified spoken-form expansion are flagged `requiresSpokenExpansion: true` and marked `AMBIGUOUS` rather than guessing acoustic word intervals.
- **Punctuation:** Marked `NON_ACOUSTIC_PUNCTUATION` and attached to adjacent alignable tokens without assigning fake acoustic duration.
