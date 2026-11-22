# AVAPARDAZ — PHASE-02 MANUAL WORD-LEVEL ANNOTATION WORKFLOW & PRAAT PACKAGE

**Document ID:** `AVP-P02-ANNOT-WORKFLOW-3.0`  
**Execution ID:** `AVP-P02-RECOVERY-003`  
**Status:** `WORKFLOW_AND_VALIDATOR_READY` | `MANUAL_TIMESTAMP_ANNOTATION = NOT_AVAILABLE` (requires human listening & Praat verification — forced aligner outputs are **NEVER** substituted for manual ground truth).

---

## 1. Strict Epistemic Rule: Forced Alignment != Ground Truth

- `sherpa-onnx-fa` (MFA) outputs **predicted boundaries** (`.TextGrid`). They may be used ONLY as *hypothesis* outputs during aligner evaluation, or as *unverified pre-segmentation drafts* that MUST undergo manual human waveform/spectrogram verification in Praat before being promoted to `annotation_state = "human_verified"`.
- Zero files may be tagged `"human_verified"` without an explicit annotator ID, timestamp, and passing `validate_textgrid.py --require-full-schema`.

---

## 2. Standard 6-Tier Praat TextGrid Schema

Every manually annotated clip uses a Praat `ooTextFile` `.TextGrid` with the following 6 `IntervalTier` layers (for multi-speaker recordings with overlapping speech, create `words_spk1`, `words_spk2`, ... so legitimate speaker overlaps are preserved without intra-tier collisions):

| Tier # | Tier Name | Content Rules |
| :-: | :--- | :--- |
| 1 | `speaker` | Speaker ID (`spk_01`, `spk_02`, ...) or `overlap` |
| 2 | `words` | Verbatim spoken lexical words — **never delete repetitions, stutters, or fillers; never rewrite colloquial Persian into formal Persian** (e.g., `"من \| من \| فکر \| می‌کنم \| که \| این \| موضوع \| مهمه"`) |
| 3 | `language` | Per-word / per-span ISO tag: `fa`, `en`, `fa-en-mixed`, `other` |
| 4 | `disfluency_events` | `FILLER`, `STUTTER`, `FALSE_START`, `SELF_CORRECTION`, `INCOMPLETE` |
| 5 | `repetition_events` | `WORD_REP`, `PHRASE_REP`, `TAKE_RETRY` |
| 6 | `annotation_uncertainty` | `LOW_SNR`, `OVERLAP`, `UNCLEAR_BOUNDARY` (empty string when clear) |

---

## 3. Validation & Inter-Annotator Agreement (IAA) Commands

1. **Validate single `.TextGrid` against audio duration & full 6-tier schema:**
   ```bash
   python3 datasets/phase02/validate_textgrid.py validate \
     --textgrid <clip.TextGrid> \
     --duration <exact_wav_duration_sec> \
     --require-full-schema
   ```
2. **Compute Inter-Annotator Agreement (mandatory on `>= 20%` of the 60-min timestamp subset):**
   ```bash
   python3 datasets/phase02/validate_textgrid.py iaa \
     --annotator-a <annotator1/clip.TextGrid> \
     --annotator-b <annotator2/clip.TextGrid> \
     --duration <exact_wav_duration_sec>
   ```
   - **Annotation Quality Targets:** `MEDIAN_ABSOLUTE_DISAGREEMENT <= 50 ms`, `P90_ABSOLUTE_DISAGREEMENT <= 150 ms`.
3. **Evaluate an ASR or Forced Aligner `.TextGrid` against Human Ground Truth:**
   ```bash
   python3 datasets/phase02/validate_textgrid.py evaluate \
     --ref <human_verified/clip.TextGrid> \
     --hyp <model_or_aligner/clip.TextGrid> \
     --duration <exact_wav_duration_sec>
   ```

---

## 4. Human Assignment Queue (Ready to Populate Once Licensed Conversational Audio Is Collected)

- Target manual word-timestamp subset: **`>= 60 minutes`** (with `>= 20%` = `>= 12 minutes` double-annotated independently for IAA).
- Current clips queued from verified `CC-BY-4.0` FLEURS `dev` (available immediately in `datasets/phase02/annotation_assignment_queue.json` once `prepare_persistent_dataset.py` runs) for pilot calibration, plus required external collection of **`>= 30 min` spontaneous Persian disfluencies** and **`>= 30 min` natural intra-sentence Persian-English code-switching**.
