#!/usr/bin/env python3
"""Unit tests for AVAPARDAZ PHASE-02 Praat TextGrid validator, alignment scorer & IAA calculator."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from validate_textgrid import (
    Interval,
    TextGrid,
    Tier,
    compute_iaa,
    evaluate_alignment,
    parse_textgrid,
    validate_textgrid,
    write_textgrid,
)


def _make_full_persian_tg() -> TextGrid:
    return TextGrid(
        xmin=0.0,
        xmax=3.5,
        tiers=[
            Tier("speaker", "IntervalTier", 0.0, 3.5, [Interval(0.0, 3.5, "spk_01")]),
            Tier(
                "words",
                "IntervalTier",
                0.0,
                3.5,
                [
                    Interval(0.10, 0.35, "من"),
                    Interval(0.40, 0.65, "من"),
                    Interval(0.70, 1.10, "فکر"),
                    Interval(1.15, 1.75, "می‌کنم"),
                    Interval(1.80, 2.00, "که"),
                    Interval(2.05, 2.30, "این"),
                    Interval(2.35, 2.85, "موضوع"),
                    Interval(2.90, 3.35, "مهمه"),
                ],
            ),
            Tier("language", "IntervalTier", 0.0, 3.5, [Interval(0.10, 3.35, "fa")]),
            Tier("disfluency_events", "IntervalTier", 0.0, 3.5, [Interval(0.10, 0.35, "REP_START")]),
            Tier("repetition_events", "IntervalTier", 0.0, 3.5, [Interval(0.10, 0.65, "WORD_REP")]),
            Tier("annotation_uncertainty", "IntervalTier", 0.0, 3.5, [Interval(0.0, 3.5, "")]),
        ],
    )


class TestTextGridValidator(unittest.TestCase):
    def test_roundtrip_and_full_schema_validation(self) -> None:
        tg = _make_full_persian_tg()
        raw = write_textgrid(tg)
        parsed = parse_textgrid(raw)
        res = validate_textgrid(parsed, audio_duration_sec=3.5, require_full_schema=True)
        self.assertTrue(res["valid"])
        self.assertEqual(res["invalid_interval_count"], 0)
        self.assertEqual(res["within_tier_overlap_count"], 0)

    def test_detects_invalid_bounds_and_intratier_overlap(self) -> None:
        bad = TextGrid(
            xmin=0.0,
            xmax=2.0,
            tiers=[
                Tier(
                    "words",
                    "IntervalTier",
                    0.0,
                    2.0,
                    [
                        Interval(-0.1, 0.5, "hello"),
                        Interval(0.4, 0.3, "world"),
                        Interval(1.0, 2.5, "overflow"),
                    ],
                )
            ],
        )
        res = validate_textgrid(bad, audio_duration_sec=2.0)
        self.assertFalse(res["valid"])
        self.assertEqual(res["invalid_interval_count"], 3)
        self.assertGreaterEqual(res["within_tier_overlap_count"], 1)

    def test_preserves_legitimate_multispeaker_overlap(self) -> None:
        tg = TextGrid(
            xmin=0.0,
            xmax=2.0,
            tiers=[
                Tier("words_spk1", "IntervalTier", 0.0, 2.0, [Interval(0.2, 1.2, "بله")]),
                Tier("words_spk2", "IntervalTier", 0.0, 2.0, [Interval(0.8, 1.6, "درسته")]),
            ],
        )
        res = validate_textgrid(tg, audio_duration_sec=2.0)
        self.assertTrue(res["valid"])
        self.assertEqual(res["preserved_cross_speaker_overlaps"], 1)

    def test_alignment_evaluation_and_iaa(self) -> None:
        ref = _make_full_persian_tg()
        hyp = TextGrid(
            xmin=0.0,
            xmax=3.5,
            tiers=[
                Tier(
                    "words",
                    "IntervalTier",
                    0.0,
                    3.5,
                    [
                        Interval(0.12, 0.37, "من"),
                        Interval(0.43, 0.68, "من"),
                        Interval(0.74, 1.13, "فکر"),
                        Interval(1.18, 1.79, "می‌کنم"),
                        Interval(1.82, 2.04, "که"),
                        Interval(2.07, 2.31, "این"),
                        Interval(2.38, 2.89, "موضوع"),
                        Interval(2.94, 3.38, "مهمه"),
                    ],
                )
            ],
        )
        ev = evaluate_alignment(ref, hyp, audio_duration_sec=3.5)
        self.assertEqual(ev["WORD_TIMESTAMP_COVERAGE"], 1.0)
        self.assertEqual(ev["MISSING_ALIGNMENT_COUNT"], 0)
        self.assertLessEqual(ev["MEDIAN_BOUNDARY_ERROR_MS"], 40.0)
        iaa = compute_iaa(ref, hyp, audio_duration_sec=3.5)
        self.assertEqual(iaa["word_transcription_agreement"], 1.0)
        self.assertTrue(iaa["meets_median_target_le_50ms"])
        self.assertTrue(iaa["meets_p90_target_le_150ms"])


if __name__ == "__main__":
    unittest.main()
