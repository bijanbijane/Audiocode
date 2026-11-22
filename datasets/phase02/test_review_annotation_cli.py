#!/usr/bin/env python3
"""Unit tests for Turnkey Human-Review Annotation Package & IAA CLI (AVP-P02-RECOVERY-007)."""

import json
import tempfile
import unittest
from pathlib import Path

from benchmarks.phase02.persian_ctc_aligner import aligned_words_to_textgrid
from datasets.phase02.review_annotation_cli import (
    DRAFT_SENTINEL,
    evaluate_package_status,
    generate_praat_review_script,
    is_textgrid_human_verified,
)


class TestReviewAnnotationCLI(unittest.TestCase):
    def test_unverified_machine_draft_never_counts_as_human_verified(self):
        words = [
            {"word": "سلام", "start": 0.10, "end": 0.40},
            {"word": "دنیا", "start": 0.45, "end": 0.90},
        ]
        draft_tg = aligned_words_to_textgrid(words, audio_duration_sec=1.0, provenance_tag=DRAFT_SENTINEL)
        self.assertFalse(is_textgrid_human_verified(draft_tg))

        verified_tg = draft_tg.replace(DRAFT_SENTINEL, "HUMAN_VERIFIED")
        self.assertTrue(is_textgrid_human_verified(verified_tg))

    def test_package_status_and_iaa_computation(self):
        with tempfile.TemporaryDirectory() as td:
            pkg = Path(td)
            for sub in ("drafts_immutable", "annotator_a", "annotator_b"):
                (pkg / sub).mkdir()

            w_draft = [{"word": "سلام", "start": 0.10, "end": 0.40}, {"word": "دنیا", "start": 0.50, "end": 0.90}]
            w_ann_a = [{"word": "سلام", "start": 0.12, "end": 0.42}, {"word": "دنیا", "start": 0.51, "end": 0.91}]
            w_ann_b = [{"word": "سلام", "start": 0.13, "end": 0.43}, {"word": "دنیا", "start": 0.52, "end": 0.92}]

            (pkg / "drafts_immutable/c1.draft.TextGrid").write_text(
                aligned_words_to_textgrid(w_draft, 60.0, provenance_tag=DRAFT_SENTINEL), encoding="utf-8"
            )
            (pkg / "annotator_a/c1.TextGrid").write_text(
                aligned_words_to_textgrid(w_draft, 60.0, provenance_tag=DRAFT_SENTINEL), encoding="utf-8"
            )
            (pkg / "annotator_b/c1.TextGrid").write_text(
                aligned_words_to_textgrid(w_draft, 60.0, provenance_tag=DRAFT_SENTINEL), encoding="utf-8"
            )

            manifest = {
                "items": [
                    {
                        "clip_id": "c1",
                        "audio_path": "/tmp/c1.wav",
                        "duration_sec": 60.0,
                        "double_annotated_iaa": True,
                        "draft_textgrid_rel": "drafts_immutable/c1.draft.TextGrid",
                        "annotator_a_textgrid_rel": "annotator_a/c1.TextGrid",
                        "annotator_b_textgrid_rel": "annotator_b/c1.TextGrid",
                    }
                ]
            }
            (pkg / "assignment_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

            st_before = evaluate_package_status(pkg)
            self.assertEqual(st_before["HUMAN_VERIFIED_MINUTES"], 0.0)
            self.assertEqual(st_before["IAA_CLIPS_SCORED"], 0)
            self.assertFalse(st_before["GATE_60_MIN_HUMAN_GOLD_MET"])

            (pkg / "annotator_a/c1.TextGrid").write_text(
                aligned_words_to_textgrid(w_ann_a, 60.0, provenance_tag="HUMAN_VERIFIED"), encoding="utf-8"
            )
            (pkg / "annotator_b/c1.TextGrid").write_text(
                aligned_words_to_textgrid(w_ann_b, 60.0, provenance_tag="HUMAN_VERIFIED"), encoding="utf-8"
            )
            st_after = evaluate_package_status(pkg)
            self.assertEqual(st_after["HUMAN_VERIFIED_MINUTES"], 1.0)
            self.assertEqual(st_after["IAA_CLIPS_SCORED"], 1)
            self.assertLessEqual(st_after["IAA_MEDIAN_DISAGREEMENT_MS"], 15.0)
            self.assertTrue(st_after["IAA_TARGETS_MET"])

            script = generate_praat_review_script(manifest["items"], "annotator_a")
            self.assertIn("View & Edit", script)
            self.assertIn("annotator_a/c1.TextGrid", script)


if __name__ == "__main__":
    unittest.main()
