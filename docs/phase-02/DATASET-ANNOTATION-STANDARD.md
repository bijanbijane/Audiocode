# AVAPARDAZ — PHASE-02: DATASET ANNOTATION & NORMALIZATION STANDARD

**Document ID:** `AVP-P02-ANNOT-STD-2.0`  
**Execution ID:** `AVP-P02-RECOVERY-002`  
**Date:** `2026-11-22`  
**Evidence Sources:**
- `docs/phase-02/BENCHMARK-PROTOCOL.md` (`sha256: 4b3f76ce3eedc287806e9a75abfc987c402495c146b6a548d90b4896b8a3a945`)
- `benchmarks/phase02/test_evaluation_metrics.py` (`sha256: 6176e2f4fb9c5b159dbe2bf816e4bc9ff08a3de8b189cabe8f848e9f5ecc68ce`, `6/6` unit tests `PASS` on `2026-11-22`)
- `benchmarks/phase02/run_cpu_bakeoff.py` (`sha256: 977584c2a1f193e855076b57bbf8ccb04c12993170db2a25cf11ef4dddf8d211`)

---

## 1. Core Principle: Strict Verbatim Annotation for Smart Audio Editing

AVAPARDAZ is a **Smart Audio Editor** whose downstream engines delete or trim unwanted speech events (fillers, repetitions, stutters, false starts, unnecessary pauses). Therefore, **clean-read captioning standards are invalid** for AVAPARDAZ evaluation.

All human reference transcripts used for Phase-02/03/06 evaluation MUST be **strictly verbatim**:

| Spoken Phenomenon | Required Verbatim Reference Format | Strictly Prohibited ("Clean" Rewrite) |
| :--- | :--- | :--- |
| **Repeated Words** | `من من فکر می‌کنم این موضوع موضوع مهمیه` | ~~`من فکر می‌کنم این موضوع مهمیه`~~ |
| **Filled Pauses / Fillers** | `امم امروز درباره ااا تدوین صدا صحبت می‌کنیم` | ~~`امروز درباره تدوین صدا صحبت می‌کنیم`~~ |
| **Stutters / Partial Words** | `ب- برنامه فردا برگزار می‌شه` | ~~`برنامه فردا برگزار می‌شود`~~ |
| **False Starts & Self-Corrections** | `می‌خواستیم شنبه نه یکشنبه ضبط کنیم` | ~~`می‌خواستیم یکشنبه ضبط کنیم`~~ |
| **Colloquial Persian Morphology** | Preserve spoken form (`می‌خوام`, `داره`, `اومدیم`) | ~~Do NOT convert to formal (`می‌خواهم`, `دارد`)~~ |
| **Intra-Sentence Code-Switching** | Preserve Latin technical terms as spoken (`با TypeScript و Docker اجرا می‌شه`) | ~~Do NOT force transliteration (`تایپ‌اسکریپت`)~~ |

---

## 2. Dual-Metric Evaluation Policy (Raw vs. `FA-RELAXED-V1`)

Every Persian evaluation run MUST report **BOTH** metrics side by side (verified in `benchmarks/phase02/test_evaluation_metrics.py`):

1. **Raw CER / Raw WER:** Exact character/word Levenshtein distance against the raw verbatim reference with zero orthographic collapsing (preserves ZWNJ, punctuation, Arabic/Persian variants, digits).
2. **Normalized CER / Normalized WER (`FA-RELAXED-V1`):** Deterministic orthographic normalization designed solely to remove non-semantic Unicode variance while **never deleting fillers, repetitions, or spoken words**:
   - Unify Arabic Yeh (`ي` `U+064A`, `ى` `U+0649`) -> Persian Yeh (`ی` `U+06CC`).
   - Unify Arabic Kaf (`ك` `U+0643`) -> Persian Kaf (`ک` `U+06A9`).
   - Normalize Teh Marbuta / Heh+Hamza variants (`ة`, `ۀ`) consistently.
   - Strip Arabic diacritics (`U+064B..U+065F`, `U+0670`) and Tatweel (`ـ` `U+0640`).
   - Normalize Persian/Arabic digits (`۰-۹`, `٠-٩`) -> ASCII digits (`0-9`).
   - Normalize ZWNJ (`U+200C`) spacing deterministically (so `می‌شود` vs `می شود` does not distort acoustic WER comparisons, while Raw CER still penalizes ZWNJ mismatches).
   - Strip non-semantic punctuation marks and collapse repeated whitespace.
   - **Never** drop repeated adjacent words (`من من` remains two tokens `["من", "من"]`).
3. **English Normalization (`EN-STD-V1`):** Lowercase, strip non-apostrophe punctuation, collapse whitespace; compute both Raw and Normalized WER.
4. **Code-Switching Metrics:** Report combined `Raw CER`, `Norm CER`, `Raw WER`, `Norm WER`, AND **Latin Token Recall** (`matched_latin_ref_tokens / total_latin_ref_tokens`), preventing Persian-only models from masking total English failure inside a blended CER score.

---

## 3. Word-Boundary Timestamp Annotation Standard (Required to Unblock `P02-12`)

To objectively evaluate word-level timestamp accuracy for audio cut boundaries:

1. **Format:** UTF-8 JSONL or Praat `.TextGrid` exported to integer milliseconds (`start_ms`, `end_ms`) on the **original unedited source timeline**.
2. **Boundary Precision:** Annotators mark acoustic onset (first glottal pulse or consonant burst) and acoustic offset (end of audible phoneme release, excluding trailing breath/silence) using waveform + spectrogram view.
3. **Event Tags:** Every word/event carries an explicit tag:
   - `WORD_FA`, `WORD_EN`, `FILLER`, `STUTTER`, `REPETITION`, `FALSE_START`, `SILENCE_GAP`.
4. **Invariants:**
   - `0 <= start_ms < end_ms <= audio_duration_ms`
   - Monotonically ordered by `start_ms`
   - Zero silent removal of repeated or disfluent tokens.
5. **Inter-Annotator Agreement Target (for future corpus creation):** Median boundary disagreement `<= 25 ms` on a 10% double-annotated QC sample.

---

## 4. Current Compliance Status

- **Normalization & Metric Unit Tests (`benchmarks/phase02/test_evaluation_metrics.py`):** **`VERIFIED`** (`6/6 PASS` in `0.014s` on `2026-11-22`).
- **Annotated Spontaneous Disfluency / Word-Boundary Corpus on Disk:** **`NOT_AVAILABLE`** (annotation standard is defined and locked; actual audio annotation remains an external prerequisite to unblock `P02-10` and `P02-12`).
