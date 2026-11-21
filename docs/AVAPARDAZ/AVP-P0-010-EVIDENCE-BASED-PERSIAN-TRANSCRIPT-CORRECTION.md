# AVP-P0-010 — Evidence-Based Persian Transcript Correction, Linguistic Error Taxonomy & Safe Repair Engine

**Status:** `VERIFIED`  
**Primary Module:** `src/asr-core/PersianEvidenceCorrectionEngine.ts`  
**Policy Version:** `FA-EVIDENCE-CORRECTION-V1.0.0`  
**Test Suite:** `src/asr-core/PersianLinguisticCorrectionAndLexical.test.ts`

---

## 1. Acoustic-Priority Correction Governance

1. **6-Tier Evidence Hierarchy:** `DIRECT_ACOUSTIC (6) > ASR_RECOGNITION (5) > ALIGNMENT (4) > LINGUISTIC (3) > DOMAIN (2) > EDITORIAL_PREFERENCE (1)`. Linguistic plausibility NEVER overrides contradictory acoustic evidence.
2. **Canonical 25-Category Persian ASR Error Taxonomy (`PERSIAN_ASR_ERROR_TAXONOMY_V1`):** Covers 5 families (`PHONETIC_ACOUSTIC`, `MORPHOLOGICAL`, `LEXICAL_SEMANTIC`, `DISCOURSE_CONVERSATIONAL`, `TEXT_REPRESENTATION`) with explicit auto-correction eligibility and known false-positive notes.
3. **Meaning-Critical Token Protection (`detectMeaningCriticalTokens`):** Protects `NEGATION`, `QUANTIFIER`, `COMPARATIVE`, `NUMBER`, `DATE_TIME`, `CURRENCY`, `PROPER_NAME`, `PRONOUN`, `MODAL`, `CONDITIONAL`, `QUESTION`, and `DIRECTIONAL` tokens against automatic replacement.
4. **Honest Confidence Provenance:** Never fabricates missing ASR confidence scores (`providerSource: 'UNAVAILABLE'`); disables automatic semantic repair when no qualified calibration dataset exists.
5. **Revision-Safe Human-in-the-Loop Ledger (`HumanInTheLoopCorrectionLedger`):** Rejects stale transcript-revision suggestions (`STALE_TRANSCRIPT_REVISION`), supports full undo/redo, and guarantees lossless `revertToOriginal()`.

## 2. Verified Adversarial Regression Results

- All **19 adversarial regression cases** (negation removal/insertion, quantifiers, comparatives, directionals, colloquial Persian preservation, proper names, numbers, currency, dates, homophones, incomplete utterances, repetitions, self-repairs, speaker boundaries, domain terms, missing confidence) verified with **`falseAutoCorrectionRate = 0`**, **`meaningChangingAutoCorrectionCount = 0`**, **`negationAutoCorruptions = 0`**, and **`colloquialPreservationRate = 1.0`**.
