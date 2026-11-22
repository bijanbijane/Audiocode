#!/usr/bin/env python3
"""
Unit & Fault-Injection Tests for AVAPARDAZ PHASE-02 Checkpoint Coordinator
and Regression Test for evaluate_utterance() keyword-only contract (AVP-P02-RECOVERY-005).
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "benchmarks" / "phase02"))
sys.path.insert(0, str(REPO_ROOT / "training" / "scripts"))

from checkpoint_coordinator import (  # noqa: E402
    CheckpointCoordinator,
    DuplicateExecutionError,
    ExperimentLock,
    atomic_write_json,
)
from evaluate_asr import evaluate_utterance  # noqa: E402


class TestCheckpointCoordinatorAndRegressions(unittest.TestCase):
    def test_evaluate_utterance_keyword_only_regression(self) -> None:
        """Regression test for the EXP2 positional-arg TypeError bug fixed in RECOVERY-004."""
        with self.assertRaises(TypeError):
            evaluate_utterance("s1", "en", 5.0, "hello world", "hello world", 1.0)  # type: ignore[misc]
        ev = evaluate_utterance(
            sample_id="s1",
            language="en",
            duration_sec=5.0,
            reference="hello world",
            hypothesis="hello world",
            inference_sec=1.0,
        )
        self.assertEqual(ev.norm_wer, 0.0)
        self.assertEqual(ev.norm_cer, 0.0)

    def test_fault_injection_mid_run_interruption_and_clean_resume(self) -> None:
        """Simulates crash mid-experiment + truncated journal line, then verifies resume skips completed items."""
        with tempfile.TemporaryDirectory() as td:
            work = Path(td)
            items = [
                {"sample_id": f"clip-{i}", "candidate_model": "m1", "model_artifact_hash": "hashA"}
                for i in range(1, 6)
            ]
            cfg = {"threads": 4, "offline": True}
            executed_run1 = []

            def failing_midway(item):
                executed_run1.append(item["sample_id"])
                if item["sample_id"] == "clip-3":
                    raise KeyboardInterrupt("Simulated agent cancellation mid-inference")
                return True, {"text": f"ok-{item['sample_id']}"}, None

            coord1 = CheckpointCoordinator("exp_fault", work, cfg, "sherpa-2.0.2")
            with self.assertRaises(KeyboardInterrupt):
                coord1.run_all(items, failing_midway)

            st1 = json.loads(coord1.state_path.read_text(encoding="utf-8"))
            self.assertEqual(st1["state"], "CANCELLED")
            self.assertEqual(st1["completed_valid_items"], 2)

            # Inject a simulated crash-truncated partial JSONL line at EOF
            with open(coord1.journal_path, "ab") as fh:
                fh.write(b'{"experiment_id": "exp_fault", "sample_id": "clip-3", "trun')

            executed_run2 = []

            def clean_exec(item):
                executed_run2.append(item["sample_id"])
                return True, {"text": f"ok-{item['sample_id']}"}, None

            coord2 = CheckpointCoordinator("exp_fault", work, cfg, "sherpa-2.0.2")
            res = coord2.run_all(items, clean_exec)
            self.assertEqual(res["state"], "COMPLETED")
            self.assertEqual(res["completed_valid_items"], 5)
            self.assertEqual(res["corrupted_journal_lines_ignored"], 1)
            # Clips 1 & 2 MUST NOT be re-executed on resume
            self.assertEqual(executed_run2, ["clip-3", "clip-4", "clip-5"])

    def test_config_or_model_hash_change_prevents_stale_reuse(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            work = Path(td)
            items_a = [{"sample_id": "clip-1", "candidate_model": "m1", "model_artifact_hash": "hashA"}]
            c1 = CheckpointCoordinator("exp_cfg", work, {"threads": 4}, "v1")
            c1.run_all(items_a, lambda it: (True, {"v": 1}, None))

            # Changing config hash forces re-execution
            ran = []
            c2 = CheckpointCoordinator("exp_cfg", work, {"threads": 2}, "v1")
            c2.run_all(items_a, lambda it: (ran.append(it["sample_id"]) is None, {"v": 2}, None))
            self.assertEqual(ran, ["clip-1"])

            # Changing model hash under same config forces re-execution
            ran2 = []
            items_b = [{"sample_id": "clip-1", "candidate_model": "m1", "model_artifact_hash": "hashB"}]
            c3 = CheckpointCoordinator("exp_cfg", work, {"threads": 2}, "v1")
            c3.run_all(items_b, lambda it: (ran2.append(it["sample_id"]) is None, {"v": 3}, None))
            self.assertEqual(ran2, ["clip-1"])

    def test_duplicate_execution_lock_blocks_concurrent_holder(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            lock_path = Path(td) / "exp.lock"
            l1 = ExperimentLock(lock_path)
            l2 = ExperimentLock(lock_path)
            l1.acquire()
            try:
                with self.assertRaises(DuplicateExecutionError):
                    l2.acquire()
            finally:
                l1.release()
            # Re-acquiring after release succeeds
            l2.acquire()
            l2.release()

    def test_failed_sample_never_silently_passes_and_bounded_retries(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            attempts = []

            def always_fail(item):
                attempts.append(item["sample_id"])
                return False, {}, "Synthetic OOM"

            c = CheckpointCoordinator("exp_retry", Path(td), {"k": 1}, "v1", max_retries=2)
            out = c.run_all(
                [{"sample_id": "bad-1", "candidate_model": "m1", "model_artifact_hash": "h1"}],
                always_fail,
            )
            self.assertEqual(len(attempts), 2)
            self.assertEqual(out["state"], "FAILED")
            self.assertEqual(out["failed_items"], 1)
            self.assertEqual(out["completed_valid_items"], 0)

    def test_atomic_write_json_clean_replace(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "state.json"
            atomic_write_json(p, {"step": 1})
            atomic_write_json(p, {"step": 2})
            self.assertEqual(json.loads(p.read_text(encoding="utf-8")), {"step": 2})
            leftovers = [f for f in Path(td).iterdir() if ".tmp." in f.name]
            self.assertEqual(leftovers, [])

    # --- AVP-P02-RECOVERY-006 Section 5: >= 5 Targeted Interruption Recovery Tests ---

    def test_interruption_01_during_inference(self) -> None:
        """1. Simulated interruption mid-inference preserves prior samples and resumes without duplication."""
        with tempfile.TemporaryDirectory() as td:
            work = Path(td)
            items = [{"sample_id": f"inf-{i}", "candidate_model": "turbo", "model_artifact_hash": "h1"} for i in range(4)]
            ran1, ran2 = [], []

            def exec1(it):
                ran1.append(it["sample_id"])
                if it["sample_id"] == "inf-2":
                    raise KeyboardInterrupt("kill during inference")
                return True, {"score": 1}, None

            c1 = CheckpointCoordinator("exp_int_inf", work, {"t": 3}, "2.0.2")
            with self.assertRaises(KeyboardInterrupt):
                c1.run_all(items, exec1)
            self.assertEqual(ran1, ["inf-0", "inf-1", "inf-2"])

            c2 = CheckpointCoordinator("exp_int_inf", work, {"t": 3}, "2.0.2")
            res = c2.run_all(items, lambda it: (ran2.append(it["sample_id"]) is None, {"score": 1}, None))
            self.assertEqual(res["state"], "COMPLETED")
            self.assertEqual(ran2, ["inf-2", "inf-3"])
            self.assertEqual([r["sample_id"] for r in res["records"]], ["inf-0", "inf-1", "inf-2", "inf-3"])

    def test_interruption_02_during_result_serialization(self) -> None:
        """2. Simulated interruption during result serialization leaves no partial record accepted as complete."""
        with tempfile.TemporaryDirectory() as td:
            work = Path(td)
            items = [{"sample_id": f"ser-{i}", "candidate_model": "turbo", "model_artifact_hash": "h1"} for i in range(3)]
            orig_append = __import__("checkpoint_coordinator").append_jsonl_durable
            call_count = {"n": 0}

            def crashing_append(path, rec):
                call_count["n"] += 1
                if call_count["n"] == 2:
                    # Simulate half-written serialized record before sudden termination
                    with open(path, "ab") as fh:
                        fh.write(b'{"experiment_id":"exp_int_ser","sample_id":"ser-1","result":{"partial":')
                    raise KeyboardInterrupt("crash mid-serialization")
                return orig_append(path, rec)

            mod = __import__("checkpoint_coordinator")
            mod.append_jsonl_durable = crashing_append
            try:
                c1 = CheckpointCoordinator("exp_int_ser", work, {"t": 3}, "2.0.2")
                with self.assertRaises(KeyboardInterrupt):
                    c1.run_all(items, lambda it: (True, {"ok": True}, None))
            finally:
                mod.append_jsonl_durable = orig_append

            ran2 = []
            c2 = CheckpointCoordinator("exp_int_ser", work, {"t": 3}, "2.0.2")
            res = c2.run_all(items, lambda it: (ran2.append(it["sample_id"]) is None, {"ok": True}, None))
            self.assertEqual(res["state"], "COMPLETED")
            self.assertEqual(res["corrupted_journal_lines_ignored"], 1)
            self.assertEqual(ran2, ["ser-1", "ser-2"])

    def test_interruption_03_during_checkpoint_writing(self) -> None:
        """3. Simulated interruption during atomic checkpoint write leaves orphan .tmp untouched and valid target intact."""
        with tempfile.TemporaryDirectory() as td:
            work = Path(td)
            target = work / "exp4_win1b.json"
            atomic_write_json(target, {"window": "1b", "rc": 0, "duration_sec": 300.0})
            # Simulate a crashed writer leaving a truncated sibling .tmp file
            orphan_tmp = work / ".exp4_win1b.json.tmp.99999.12345"
            orphan_tmp.write_text('{"window": "1b", "trun', encoding="utf-8")
            # Original committed checkpoint remains valid and uncorrupted
            loaded = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(loaded["rc"], 0)
            self.assertEqual(loaded["duration_sec"], 300.0)
            # Subsequent atomic write cleanly replaces target without reading orphan .tmp
            atomic_write_json(target, {"window": "1b", "rc": 0, "duration_sec": 300.0, "verified": True})
            self.assertTrue(json.loads(target.read_text(encoding="utf-8"))["verified"])

    def test_interruption_04_during_window_completion(self) -> None:
        """4. Simulated interruption between contiguous timeline windows preserves completed windows and finishes missing ones."""
        with tempfile.TemporaryDirectory() as td:
            work = Path(td)
            windows = [
                {"sample_id": "win-0", "candidate_model": "turbo-vad", "model_artifact_hash": "hW", "offset": 0, "dur": 600},
                {"sample_id": "win-1a", "candidate_model": "turbo-vad", "model_artifact_hash": "hW", "offset": 600, "dur": 300},
                {"sample_id": "win-1b", "candidate_model": "turbo-vad", "model_artifact_hash": "hW", "offset": 900, "dur": 300},
                {"sample_id": "win-2a", "candidate_model": "turbo-vad", "model_artifact_hash": "hW", "offset": 1200, "dur": 300},
                {"sample_id": "win-2b", "candidate_model": "turbo-vad", "model_artifact_hash": "hW", "offset": 1500, "dur": 300},
            ]
            c1 = CheckpointCoordinator("exp4_win_test", work, {"range": [0, 1800]}, "2.0.2")

            def stop_after_1a(w):
                if w["sample_id"] == "win-1b":
                    raise KeyboardInterrupt("session cancelled after 1a")
                return True, {"offset": w["offset"], "dur": w["dur"]}, None

            with self.assertRaises(KeyboardInterrupt):
                c1.run_all(windows, stop_after_1a)

            resumed = []
            c2 = CheckpointCoordinator("exp4_win_test", work, {"range": [0, 1800]}, "2.0.2")
            res = c2.run_all(
                windows,
                lambda w: (resumed.append(w["sample_id"]) is None, {"offset": w["offset"], "dur": w["dur"]}, None),
            )
            self.assertEqual(resumed, ["win-1b", "win-2a", "win-2b"])
            self.assertEqual(res["state"], "COMPLETED")
            total_dur = sum(r["result"]["dur"] for r in res["records"])
            self.assertEqual(total_dur, 1800)

    def test_interruption_05_during_status_update_and_stale_lock_recovery(self) -> None:
        """5. Simulated crash leaving stale lockfile (dead PID) and stale RUNNING state reconciles cleanly from durable journal."""
        with tempfile.TemporaryDirectory() as td:
            work = Path(td)
            items = [{"sample_id": f"st-{i}", "candidate_model": "m1", "model_artifact_hash": "h1"} for i in range(3)]
            c1 = CheckpointCoordinator("exp_int_state", work, {"k": 1}, "2.0.2")
            c1.run_all(items, lambda it: (True, {"done": it["sample_id"]}, None))

            # Simulate crash right before final COMPLETED state write + stale lock from dead PID
            c1.write_state("RUNNING", 3, 2, 0, reason="Stale pre-crash status")
            c1.lock_path.write_text(json.dumps({"pid": 999999, "host": "dead-container"}), encoding="utf-8")

            ran_again = []
            c2 = CheckpointCoordinator("exp_int_state", work, {"k": 1}, "2.0.2")
            res = c2.run_all(items, lambda it: (ran_again.append(it["sample_id"]) is None, {"done": it["sample_id"]}, None))
            # All 3 samples already durable in JSONL journal -> 0 re-executions, state reconciled to COMPLETED
            self.assertEqual(ran_again, [])
            self.assertEqual(res["state"], "COMPLETED")
            self.assertEqual(res["completed_valid_items"], 3)
            final_state = json.loads(c2.state_path.read_text(encoding="utf-8"))
            self.assertEqual(final_state["state"], "COMPLETED")


if __name__ == "__main__":
    unittest.main()
