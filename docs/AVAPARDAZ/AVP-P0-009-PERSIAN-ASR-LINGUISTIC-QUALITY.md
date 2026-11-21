# AVP-P0-009 — Persian ASR Linguistic Fidelity, Text Normalization & Transcript Quality Engineering

**Status:** `VERIFIED`  
**Primary Module:** `src/asr-core/PersianLinguisticQualityEngine.ts`  
**Policy Version:** `FA-LINGUISTIC-V1.0.0`  
**Test Suite:** `src/asr-core/PersianLinguisticCorrectionAndLexical.test.ts`

---

## 1. 5-Layer Non-Destructive Persian Transcript Architecture

1. **Raw ASR Layer (`rawAsrText`):** Preserves the exact recognized speech output immutably.
2. **Script-Aware Normalized Layer (`normalizedText`):** Deterministically converts Arabic `ي`/`ك` to Persian `ی`/`ک` ONLY in Persian/Arabic script context without corrupting Latin/technical tokens, and normalizes Persian half-space (`ZWNJ` `\u200c`) rules (`می‌روم`, `کتاب‌ها`, `نمی‌شود`).
3. **Explicit Fidelity Modes:** `VERBATIM` (strictly preserves colloquial spoken forms like `میخوام`, `واسه`, `خونه`), `LIGHT_NORMALIZED`, and `EDITORIAL_SUGGESTED` (non-destructive).
4. **Non-Destructive Punctuation Separation:** Separates acoustic pause punctuation from linguistic punctuation suggestions without overwriting spoken tokens.
5. **Independent Digit Policy & Alignment Fidelity:** Keeps digit display formatting (`PERSIAN_DIGITS | ASCII_DIGITS | PRESERVE_SOURCE`) independent from lexical content, and tracks `1:1`, `MANY_TO_ONE`, and `UNALIGNED` token-to-audio mapping statuses.
6. **Reproducible Persian WER/CER Evaluator:** Computes raw vs normalized Persian WER/CER with explicit policy versioning and reports `BLOCKED_NO_CORPUS` when no human-verified reference dataset is supplied.

## 2. Verified Automated Evidence

- `src/asr-core/PersianLinguisticCorrectionAndLexical.test.ts` (`AVP-P0-009` suite): **PASS**.
