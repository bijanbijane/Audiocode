# AVP-P0-012 — Persian Lexical Fidelity, Contextual Disambiguation & Proper-Noun Preservation

**Status:** `VERIFIED`  
**Primary Module:** `src/asr-core/PersianLexicalDisambiguationEngine.ts`  
**Test Suite:** `src/asr-core/PersianLinguisticCorrectionAndLexical.test.ts`

---

## 1. Anti-Overcorrection Lexical Architecture

1. **Versioned O(1)-Indexed Domain Vocabulary (`DomainVocabularyRegistry`):** Supports scalable O(1) lookup across 10,000+ entries with explicit entry provenance and versioned metadata.
2. **Unverified Machine-Guess Quarantine:** Machine-proposed vocabulary candidates are quarantined (`UNVERIFIED_CANDIDATE`) and never promoted into active disambiguation until explicitly approved by a human reviewer.
3. **Proper-Noun, Acronym & Identifier Protection:** Prevents frequent common nouns or language-model priors from overwriting rare Persian proper names, technical acronyms, or structured identifiers.
4. **Non-Destructive Compound & Homophone Analysis:** Flags Persian compound boundaries and homophone candidates strictly for evidence-constrained evaluation, routing all proposed edits through `evaluateProposedCorrection` (`AVP-P0-010`) so contextual plausibility never overrides acoustic evidence.

## 2. Verified Automated Evidence

- `src/asr-core/PersianLinguisticCorrectionAndLexical.test.ts` (`AVP-P0-012` suite): **PASS** (10,000-entry O(1) benchmark, machine-guess quarantine enforcement, proper-noun/acronym preservation, compound analysis, and P0-010 routing).
