#!/usr/bin/env python3
"""Unit tests for FA-Bench dual-track evaluator (AVP-P02-RECOVERY-007)."""

import unittest
from benchmarks.phase02.fa_bench_eval import (
    WordInterval,
    aggregate_dual_track,
    evaluate_utterance_dual_track,
    normalize_word_label,
)


class TestFABenchDualTrack(unittest.TestCase):
    def test_persian_normalization_canonicalizes_kaf_yeh_and_diacritics(self):
        self.assertEqual(normalize_word_label("كِتابي"), normalize_word_label("کتابی"))
        self.assertEqual(normalize_word_label("می‌روم"), normalize_word_label("میروم"))

    def test_track_a_perfect_alignment(self):
        ref = [
            WordInterval("سلام", 0.10, 0.40),
            WordInterval("سلام", 0.45, 0.80),  # repeated consecutive word
            WordInterval("دنیا", 0.80, 1.20),
        ]
        hyp = [
            WordInterval("سلام", 0.11, 0.41),  # 10ms err
            WordInterval("سلام", 0.46, 0.81),  # 10ms err
            WordInterval("دنیا", 0.81, 1.22),  # 10ms/20ms err
        ]
        u = evaluate_utterance_dual_track(ref, hyp, audio_duration_sec=1.5, track="TRACK_A_REFERENCE")
        agg = aggregate_dual_track([u], track="TRACK_A_REFERENCE", reference_provenance="HUMAN_VERIFIED_GOLD")
        self.assertEqual(agg["WORD_COVERAGE"], 1.0)
        self.assertEqual(agg["MISSING_WORD_RATE"], 0.0)
        self.assertEqual(agg["INVALID_INTERVAL_RATE"], 0.0)
        self.assertEqual(agg["repeated_word_pairs_ref"], 1)
        self.assertEqual(agg["repeated_word_pairs_preserved"], 1)
        self.assertEqual(agg["tolerance_f1"]["25ms"]["f1"], 1.0)
        self.assertLessEqual(agg["START_BOUNDARY_ERROR_MS"]["mae_ms"], 15.0)
        self.assertLessEqual(agg["END_BOUNDARY_ERROR_MS"]["mae_ms"], 15.0)
        self.assertTrue(agg["gold_verified"])

    def test_track_b_penalizes_insertions_deletions_substitutions(self):
        ref = [
            WordInterval("این", 0.0, 0.3),
            WordInterval("یک", 0.3, 0.6),
            WordInterval("آزمایش", 0.6, 1.1),
            WordInterval("است", 1.1, 1.4),
        ]
        # ASR deletes "یک" and substitutes "آزمایش" -> "آزمایشی" (3 hyp words vs 4 ref words)
        hyp = [
            WordInterval("این", 0.0, 0.3),
            WordInterval("آزمایشی", 0.55, 1.1),
            WordInterval("است", 1.1, 1.4),
        ]
        u = evaluate_utterance_dual_track(ref, hyp, audio_duration_sec=1.5, track="TRACK_B_ASR_HYPOTHESIS")
        agg = aggregate_dual_track([u], track="TRACK_B_ASR_HYPOTHESIS", reference_provenance="INTER_SYSTEM_COMPARISON_ONLY")
        self.assertFalse(agg["gold_verified"])
        self.assertEqual(agg["total_matched_words"], 2)
        self.assertEqual(agg["WORD_COVERAGE"], 0.5)
        self.assertEqual(agg["MISSING_WORD_RATE"], 0.5)
        self.assertEqual(agg["deletions"], 1)
        self.assertEqual(agg["substitutions"], 1)
        self.assertEqual(agg["insertions"], 0)
        # Strict F1 must be substantially below 1.0 even though matched words have tight boundaries
        self.assertLess(agg["tolerance_f1"]["50ms"]["f1"], 0.8)

        # Also verify insertion penalty when ASR inserts an extra word
        hyp_ins = [
            WordInterval("این", 0.0, 0.3),
            WordInterval("یک", 0.3, 0.6),
            WordInterval("خب", 0.6, 0.7),
            WordInterval("آزمایش", 0.7, 1.1),
            WordInterval("است", 1.1, 1.4),
        ]
        u_ins = evaluate_utterance_dual_track(ref, hyp_ins, audio_duration_sec=1.5, track="TRACK_B_ASR_HYPOTHESIS")
        self.assertEqual(u_ins["insertions"], 1)
        self.assertLess(u_ins["tolerance_f1"]["50ms"]["precision"], 1.0)

    def test_invalid_interval_detection(self):
        ref = [WordInterval("تست", 0.1, 0.5)]
        hyp = [WordInterval("تست", 0.5, 0.4)]  # end <= start
        u = evaluate_utterance_dual_track(ref, hyp, audio_duration_sec=1.0, track="TRACK_A_REFERENCE")
        self.assertEqual(u["invalid_interval_count"], 1)
        self.assertEqual(u["INVALID_INTERVAL_RATE"], 1.0)


if __name__ == "__main__":
    unittest.main()
