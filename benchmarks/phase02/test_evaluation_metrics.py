#!/usr/bin/env python3
"""
Unit tests for AVAPARDAZ PHASE-02 canonical Persian/English/Code-Switch
ASR evaluation metrics, normalization (FA-RELAXED-V1), paired bootstrap CI,
and Sherpa-ONNX output parser.
"""

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "training" / "scripts"))
sys.path.insert(0, str(REPO_ROOT / "benchmarks" / "phase02"))

from evaluate_asr import (  # noqa: E402
    aggregate_metrics,
    compute_cer,
    compute_latin_token_recall,
    compute_wer,
    evaluate_utterance,
    normalize_english_v1,
    normalize_persian_relaxed_v1,
    paired_bootstrap_ci,
)
from run_cpu_bakeoff import parse_sherpa_output  # noqa: E402


class TestPhase02EvaluationMetrics(unittest.TestCase):
    def test_persian_relaxed_v1_unifies_arabic_variants_zwnj_and_digits(self):
        a = "كتابِ فارسیِ ۱۴۰۵ می‌خواهم"
        b = "کتاب فارسی 1405 می خواهم"
        self.assertEqual(normalize_persian_relaxed_v1(a), normalize_persian_relaxed_v1(b))
        self.assertEqual(normalize_persian_relaxed_v1(a), "کتاب فارسی 1405 می خواهم")

    def test_raw_vs_normalized_cer_preserves_orthographic_differences(self):
        ev = evaluate_utterance(
            sample_id="fa-1",
            language="fa",
            duration_sec=5.0,
            reference="می‌خواهم کتاب بخرم",
            hypothesis="می خواهم كتاب بخرم",
            inference_sec=1.0,
        )
        self.assertGreater(ev.raw_cer, 0.0)
        self.assertEqual(ev.norm_cer, 0.0)
        self.assertEqual(ev.norm_wer, 0.0)

    def test_english_wer_and_normalization(self):
        self.assertEqual(normalize_english_v1("Hello, World!"), "hello world")
        wer, edits, ref_len = compute_wer("hello world today", "hello word today")
        self.assertEqual(edits, 1)
        self.assertEqual(ref_len, 3)
        self.assertAlmostEqual(wer, 1.0 / 3.0, places=5)

    def test_code_switch_latin_token_recall(self):
        ref = "امروز درباره Backend و TypeScript در Docker صحبت می‌کنیم"
        hyp = "امروز درباره backend و typescript در داکر صحبت می‌کنیم"
        recall = compute_latin_token_recall(ref, hyp)
        self.assertIsNotNone(recall)
        self.assertAlmostEqual(recall or 0.0, 2.0 / 3.0, places=5)

    def test_paired_bootstrap_ci_detects_improvement_deterministically(self):
        base = [(5, 20), (4, 20), (6, 20), (5, 20), (4, 20)]
        cand = [(2, 20), (1, 20), (2, 20), (2, 20), (1, 20)]
        r1 = paired_bootstrap_ci(base, cand, iterations=2000, seed=42)
        r2 = paired_bootstrap_ci(base, cand, iterations=2000, seed=42)
        self.assertEqual(r1, r2)
        self.assertLess(r1["delta_pp"], 0.0)
        self.assertLess(r1["ci_high_pp"], 0.0)

    def test_aggregate_metrics_and_sherpa_parser(self):
        ev1 = evaluate_utterance(
            sample_id="s1",
            language="en",
            duration_sec=4.0,
            reference="test one",
            hypothesis="test one",
            inference_sec=0.8,
        )
        agg = aggregate_metrics([ev1])
        self.assertEqual(agg["sample_count"], 1)
        self.assertEqual(agg["rtf"], 0.2)
        self.assertEqual(agg["norm_wer_pct"], 0.0)

        sample_stdout = '{"lang": "fa", "text": "سلام دنیا"}\n'
        sample_stderr = (
            "/tmp/a.wav\n"
            "----\n"
            "recognizer created in 0.420 s\n"
            "Elapsed seconds: 1.250 s\n"
        )
        tr, load_s, dec = parse_sherpa_output(sample_stdout, sample_stderr, ["/tmp/a.wav"])
        self.assertEqual(tr["/tmp/a.wav"], "سلام دنیا")
        self.assertEqual(load_s, 0.42)
        self.assertEqual(dec, 1.25)


if __name__ == "__main__":
    unittest.main()
