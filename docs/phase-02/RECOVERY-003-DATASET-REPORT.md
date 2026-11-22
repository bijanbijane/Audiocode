# AVAPARDAZ — PHASE-02 RECOVERY-003 DATASET REPORT

**Document ID:** `AVP-P02-REC003-DATA-001`  
**Execution Series:** `AVP-P02-RECOVERY-003` / `RECOVERY-004` / `RECOVERY-005`  
**Dataset Version:** `avp-p02-v1`  
**Date (UTC):** `2026-11-22`  
**Overall Dataset Gate Status:** `PARTIAL / BLOCKED` (persistent legally-verified corpus built; conversational Persian, disfluency, intra-sentence code-switching, and manual Praat TextGrid ground truth remain externally missing)

---

## 1. Persistent Archive Architecture & Provenance

To eliminate the prior `/tmp` ephemerality defect, all Phase-02 audio assets were persisted outside `/tmp` and outside Git tracking in `/root/.avapardaz/datasets/avp-p02-v1/`, indexed by an immutable SHA-256 JSONL manifest in the repository:

- **Builder Script:** `benchmarks/phase02/build_persistent_dataset.py`
- **Repository Manifest:** `datasets/phase02/manifest_v1.jsonl`
  - **SHA-256:** `681ddb093c79fd6c1ef33929c739a52b9f41889a81a3654f1d5d98588931b7bd`
- **Summary Artifact:** `datasets/phase02/dataset_summary_v1.json`
- **Annotation Pilot Queue:** `datasets/phase02/annotation_assignment_queue.json` (`60` clips, `20%` double-annotation IAA assignment flags)
- **Audio Archive Root:** `/root/.avapardaz/datasets/avp-p02-v1/` (16 kHz mono PCM16 WAV)

### 1.1 Verified Corpus Inventory (`[Observed Fact]`)

| Subset | Source | License | Split Integrity | Clips | Verified Duration (h) | Notes |
| --- | --- | --- | --- | ---: | ---: | --- |
| Persian Read Speech | `google/fleurs` (`fa_ir/dev`) | `CC-BY-4.0` | `test` split untouched | 369 | 1.5278 | Real human recordings, SHA-256 indexed |
| English Read Speech | `google/fleurs` (`en_us/dev`) | `CC-BY-4.0` | `test` split untouched | 394 | 1.0459 | Real human recordings, SHA-256 indexed |
| Continuous Long Audio | LibriVox *Bleak House* Section 3 | `CC0-1.0` (Public Domain) | Unbroken single file | 1 | 0.9898 | `3,563.337 s` (`59.39 min`), `sha256: 1d3e0bfc16aff05e0241fa1f7ae77592132d6a12a4c032c320a66d7b50cdef01` |
| **Total Verified** | — | **Permissive / Public Domain** | **Verified** | **764** | **3.5635** | **0 exact duplicates, 0 near-duplicates** |

### 1.2 Partitioning & Deduplication Audit

- **Dev Partition:** `200` clips (`0.6839 h`) — meets clip-count floor (`>= 100` clips), below `2.0 h` duration target.
- **Held-out Partition:** `563` clips (`1.8899 h`) — meets clip-count floor (`>= 200` clips), below `4.0 h` duration target.
- **Long-Audio Partition:** `1` unbroken file (`0.9898 h`, `59.39 min`).
- **Exact Duplicate Check (SHA-256):** `0` exact duplicates skipped.
- **Acoustic Near-Duplicate Check (peak-normalized 32-bin energy profile + `0.01 s` duration key):** `0` near-duplicates flagged.
- **Speaker Count Honesty Note:** `google/fleurs` `dev` metadata provides recording IDs and gender labels, not verified globally unique speaker IDs; therefore the corpus is **NOT** claimed to have `>= 20` verified distinct held-out speakers without independent diarization/metadata provenance.

---

## 2. Legally Rejected External Candidates

During automated source inspection, three third-party Persian Hugging Face speech datasets were explicitly audited and **REJECTED** from ingestion to prevent copyright/ToS contamination:

1. **`Thomcles/Persian-Farsi-Speech`** — Rejected: YouTube-scraped audio without verifiable commercial redistribution clearance.
2. **`pourmand1376/...` (YouTube-derived Persian corpora)** — Rejected: Unclear commercial audio rights / platform ToS risk.
3. **`SeyedAli/Persian-Speech-Dataset`** — Rejected: Missing verifiable upstream audio license provenance.

---

## 3. Praat TextGrid Annotation Tooling & Workflow

To unblock human annotation as soon as cleared Persian/bilingual recordings are supplied, the full validation toolchain was built and unit-tested:

- **Validator CLI:** `datasets/phase02/validate_textgrid.py` (enforces `ooTextFile`, `words` tier presence, non-negative monotonic intervals, zero within-tier overlap, duration bounds, and boundary precision metrics).
- **Unit Test Suite:** `datasets/phase02/test_textgrid_validator.py` (**4/4 PASS**).
- **Operational SOP:** `datasets/phase02/ANNOTATION-WORKFLOW.md` (Praat workflow, disfluency/code-switching tagging conventions, `>= 20%` IAA double-annotation protocol).

---

## 4. Explicit Shortfalls Against Phase-02 Target Gates (`BLOCKERS`)

| Target Requirement | Required Target | Verified Actual (`avp-p02-v1`) | Gate Status |
| --- | --- | --- | --- |
| Persistent archive outside `/tmp` & SHA-256 manifest | Required | `/root/.avapardaz/datasets/avp-p02-v1` + `manifest_v1.jsonl` | **PASS** |
| Total benchmark duration | `>= 6.0 h` | `3.5635 h` (`764` unique clips) | **FAIL (Shortfall: `2.44 h`)** |
| Dev / Held-out clip floors | `>= 100` dev / `>= 200` held-out | `200` dev / `563` held-out | **PASS** |
| Dev / Held-out duration targets | `>= 2.0 h` dev / `>= 4.0 h` held-out | `0.6839 h` dev / `1.8899 h` held-out | **FAIL** |
| Genuine continuous long recording (`>= 30 min`) | `>= 30 min` unbroken | `59.39 min` unbroken LibriVox (`CC0-1.0`) | **PASS (EN)** / **MISSING (FA)** |
| Natural Persian conversational podcasts/interviews | Required | `0.0 h` | **BLOCKED (External)** |
| Natural Persian disfluencies (um/uh, false starts, repairs) | `>= 0.5 h` (`30 min`) | `0.0 h` | **BLOCKED (External)** |
| Natural intra-sentence FA–EN code-switching | `>= 0.5 h` (`30 min`) | `0.0 h` | **BLOCKED (External)** |
| Manual human Praat TextGrid word timestamps (`20%` IAA) | `>= 1.0 h` (`60 min`) | `0.0 h` | **BLOCKED (External)** |

> **Epistemic Boundary:** Forced-aligner TextGrids generated in `EXP2` (`sherpa-onnx-fa`) are strictly labeled as machine alignment outputs and are **never** substituted for manual human Praat ground truth.
