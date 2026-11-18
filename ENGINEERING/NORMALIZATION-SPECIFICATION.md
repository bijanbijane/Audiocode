# TEXT NORMALIZATION SPECIFICATION — PHASE 3 & PHASE 4

**Document Version:** `1.0.0-phase3`  
**Implementation Module:** `normalizeTranscriptWithVersion` in `/src/ai-engine/asr/AsrDatasetAndBehavioralBenchmarkEngine.ts`

---

## 1. Versioned Normalization Profiles

1. **`FA-STRICT-V1` (Persian Strict Orthographic Standard):**
   - Applies Unicode `NFC`.
   - Unifies Arabic Kaf (`U+0643` $\rightarrow$ `U+06A9`) and Arabic Yeh/Alef Maksura (`U+064A`, `U+0649` $\rightarrow$ `U+06CC`).
   - Strips Arabic diacritics (`U+064B`..`U+065F`, `U+0670`) and Tatweel/Kashida (`U+0640`).
   - **Preserves `U+200C` (Zero-Width Non-Joiner / Half-Space)** while collapsing duplicate adjacent ZWNJs (`\u200C{2,}` $\rightarrow$ `\u200C`).
   - Converts Persian (`۰-۹`) and Eastern Arabic (`٠-٩`) digits to canonical ASCII digits (`0-9`).
   - Removes punctuation and collapses whitespace.

2. **`FA-RELAXED-V1` (Persian Spoken / ZWNJ-Tolerant Standard):**
   - Applies all character and digit unifications of `FA-STRICT-V1`.
   - **Replaces `U+200C` (ZWNJ) with standard space (`U+0020`)** and canonicalizes common colloquial verb prefixes so pure half-space differences are separated from true lexical recognition errors.

3. **`EN-NORM-V1` (English Technical Standard):**
   - Lowercases Latin characters, normalizes curly apostrophes, expands standard contractions (`can't` $\rightarrow$ `cannot`, `it's` $\rightarrow$ `it is`, `we're` $\rightarrow$ `we are`), standardizes digits, strips punctuation, and collapses whitespace.

4. **`MIXED-NORM-V1` (Persian-English Code-Switching Standard):**
   - Applies `FA-STRICT-V1` to Persian spans and `EN-NORM-V1` to embedded Latin technical tokens while normalizing script-boundary whitespace (`Persian` $\leftrightarrow$ `Latin`).
