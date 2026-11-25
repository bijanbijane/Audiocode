# SHAHAB-027 Persian Subtitle Segmentation Policy

- Deterministic Persian-aware line breaking preserves ZWNJ compounds as atomic tokens, attaches Persian punctuation (`،؛؟.!`) to preceding words, balances 2-line captions, and never silently deletes spoken words to hit line limits.
- Visual grapheme clusters counted via `Intl.Segmenter('fa', { granularity: 'grapheme' })` excluding invisible ZWNJ and bidi controls.
