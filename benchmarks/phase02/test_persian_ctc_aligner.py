#!/usr/bin/env python3
"""Unit tests for Persian CTC Viterbi Forced Aligner (AVP-P02-RECOVERY-007)."""

import unittest
import numpy as np

from benchmarks.phase02.persian_ctc_aligner import (
    ShenavaCTCAligner,
    aligned_words_to_textgrid,
)
from datasets.phase02.validate_textgrid import parse_textgrid, validate_textgrid


class _MockCTCAligner(ShenavaCTCAligner):
    """Lightweight mock that tests exact Viterbi DP & BPE tokenization without ONNX load."""

    def __init__(self) -> None:
        self.blank_id = 5
        self.unk_id = 0
        self.id_to_tok = {
            0: "<unk>",
            1: "\u2581سلام",
            2: "\u2581دنیا",
            3: "\u2581خوب",
            4: "ی",
            5: "<blk>",
        }
        self.tok_to_id = {v: k for k, v in self.id_to_tok.items()}
        self.max_tok_len = max(len(t) for t in self.tok_to_id)
        self.frame_sec = 0.08


class TestPersianCTCAligner(unittest.TestCase):
    def test_viterbi_preserves_repeated_consecutive_words(self):
        al = _MockCTCAligner()
        words, flat_ids, spans = al.encode_transcript_words("سلام سلام دنیا")
        self.assertEqual(words, ["سلام", "سلام", "دنیا"])
        self.assertEqual(flat_ids, [1, 1, 2])
        self.assertEqual(spans, [(0, 1), (1, 2), (2, 3)])

        lp = np.full((20, 6), -10.0, dtype=np.float32)
        lp[:, 5] = -0.1
        lp[2:5, 1] = -0.05
        lp[2:5, 5] = -5.0
        lp[8:11, 1] = -0.05
        lp[8:11, 5] = -5.0
        lp[14:18, 2] = -0.05
        lp[14:18, 5] = -5.0

        tok_spans = al.viterbi_align_tokens(lp, flat_ids)
        self.assertEqual(len(tok_spans), 3)
        self.assertEqual((tok_spans[0][0], tok_spans[0][1]), (2, 5))
        self.assertEqual((tok_spans[1][0], tok_spans[1][1]), (8, 11))
        self.assertEqual((tok_spans[2][0], tok_spans[2][1]), (14, 18))

    def test_textgrid_export_stamps_unverified_machine_draft_and_validates(self):
        words = [
            {"word": "سلام", "start": 0.16, "end": 0.40},
            {"word": "سلام", "start": 0.64, "end": 0.88},
            {"word": "دنیا", "start": 1.12, "end": 1.44},
        ]
        tg_str = aligned_words_to_textgrid(words, audio_duration_sec=1.60)
        self.assertIn("UNVERIFIED_MACHINE_DRAFT", tg_str)
        tg = parse_textgrid(tg_str)
        res = validate_textgrid(tg, audio_duration_sec=1.60, require_full_schema=True)
        self.assertTrue(res["valid"], res["errors"])
        self.assertEqual(res["invalid_interval_count"], 0)
        self.assertEqual(res["within_tier_overlap_count"], 0)


if __name__ == "__main__":
    unittest.main()
