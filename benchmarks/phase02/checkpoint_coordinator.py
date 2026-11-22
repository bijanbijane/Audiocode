#!/usr/bin/env python3
"""
AVAPARDAZ — PHASE-02 Interruption-Resilient Atomic Checkpoint & Resume Coordinator

Guarantees (AVP-P02-RECOVERY-005 Section 6):
1. Per-sample immediate persistence with experiment_id, sample_id, candidate_model,
   model_artifact_hash, runtime_version, config_hash, hardware_profile, result,
   processing_time_sec, error_status, and completion timestamp.
2. Crash-safe atomic writes (temp file -> flush -> fsync -> os.replace) for state & JSON
   and fsynced line-delimited JSONL journal with corrupted-tail recovery.
3. Strict resume semantics: skips a sample ONLY if status=='OK' AND model_artifact_hash
   AND config_hash match the current run configuration exactly.
4. Duplicate execution protection via PID-checked lockfile + fcntl advisory lock.
5. Durable lifecycle states: PENDING, RUNNING, COMPLETED, PARTIAL, FAILED, CANCELLED.
6. Bounded retry for transient failures (never silently promotes FAILED to PASS).
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import platform
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple


VALID_STATES = ("PENDING", "RUNNING", "COMPLETED", "PARTIAL", "FAILED", "CANCELLED")


def canonical_config_hash(config: Dict[str, Any]) -> str:
    payload = json.dumps(config, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def atomic_write_json(path: Path, data: Dict[str, Any]) -> None:
    """Writes JSON atomically via sibling temp file + flush + fsync + os.replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.parent / f".{path.name}.tmp.{os.getpid()}.{time.time_ns()}"
    encoded = json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")
    with open(tmp_path, "wb") as fh:
        fh.write(encoded)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp_path, path)


def append_jsonl_durable(path: Path, record: Dict[str, Any]) -> None:
    """Appends one complete JSONL record and fsyncs immediately."""
    path.parent.mkdir(parents=True, exist_ok=True)
    line = (json.dumps(record, ensure_ascii=False) + "\n").encode("utf-8")
    with open(path, "ab") as fh:
        fh.write(line)
        fh.flush()
        os.fsync(fh.fileno())


def _pid_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class DuplicateExecutionError(RuntimeError):
    pass


class ExperimentLock:
    """PID-verified exclusive lock preventing duplicate concurrent runs of the same experiment."""

    def __init__(self, lock_path: Path) -> None:
        self.lock_path = lock_path
        self._fd: Optional[int] = None

    def acquire(self) -> None:
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        # Inspect existing lock before opening
        if self.lock_path.exists():
            try:
                info = json.loads(self.lock_path.read_text(encoding="utf-8"))
                old_pid = int(info.get("pid", -1))
                if old_pid != os.getpid() and _pid_is_alive(old_pid):
                    # Try non-blocking flock below to confirm active holder
                    pass
            except Exception:
                pass

        fd = os.open(str(self.lock_path), os.O_CREAT | os.O_RDWR, 0o644)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            holder = self.lock_path.read_text(encoding="utf-8", errors="replace").strip()
            raise DuplicateExecutionError(f"Experiment lock already held at {self.lock_path}: {holder}")

        os.ftruncate(fd, 0)
        os.lseek(fd, 0, os.SEEK_SET)
        meta = json.dumps({
            "pid": os.getpid(),
            "acquired_utc": datetime.now(timezone.utc).isoformat(),
            "host": platform.node(),
        }).encode("utf-8")
        os.write(fd, meta)
        os.fsync(fd)
        self._fd = fd

    def release(self) -> None:
        if self._fd is not None:
            try:
                fcntl.flock(self._fd, fcntl.LOCK_UN)
            finally:
                os.close(self._fd)
                self._fd = None
            try:
                self.lock_path.unlink(missing_ok=True)
            except OSError:
                pass

    def __enter__(self) -> "ExperimentLock":
        self.acquire()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.release()


class CheckpointCoordinator:
    """Manages durable lifecycle state, per-sample checkpoints, resume validation & bounded retries."""

    def __init__(
        self,
        experiment_id: str,
        work_dir: Path,
        config: Dict[str, Any],
        runtime_version: str,
        hardware_profile: Optional[str] = None,
        max_retries: int = 2,
    ) -> None:
        self.experiment_id = experiment_id
        self.work_dir = work_dir
        self.config = config
        self.config_hash = canonical_config_hash(config)
        self.runtime_version = runtime_version
        self.hardware_profile = hardware_profile or f"{platform.system()} {platform.release()} {platform.machine()}"
        self.max_retries = max_retries

        self.work_dir.mkdir(parents=True, exist_ok=True)
        self.state_path = self.work_dir / f"{experiment_id}.state.json"
        self.journal_path = self.work_dir / f"{experiment_id}.checkpoints.jsonl"
        self.lock_path = self.work_dir / f"{experiment_id}.lock"
        self.corrupted_lines_recovered = 0

    def load_valid_checkpoints(self) -> Dict[str, Dict[str, Any]]:
        """
        Loads JSONL checkpoint journal, safely ignoring any truncated/corrupted trailing line
        from a prior crash, and keeps only records matching current config_hash & model_artifact_hash.
        """
        latest: Dict[str, Dict[str, Any]] = {}
        if not self.journal_path.exists():
            return latest
        raw_lines = self.journal_path.read_text(encoding="utf-8", errors="replace").splitlines()
        for ln in raw_lines:
            s = ln.strip()
            if not s:
                continue
            try:
                rec = json.loads(s)
            except json.JSONDecodeError:
                self.corrupted_lines_recovered += 1
                continue
            if not isinstance(rec, dict) or "sample_id" not in rec or "config_hash" not in rec:
                self.corrupted_lines_recovered += 1
                continue
            if rec.get("experiment_id") != self.experiment_id:
                continue
            if rec.get("config_hash") != self.config_hash:
                # Incompatible configuration — do NOT reuse
                continue
            latest[str(rec["sample_id"])] = rec
        return latest

    def write_state(self, state: str, total: int, completed: int, failed: int, reason: str = "") -> None:
        if state not in VALID_STATES:
            raise ValueError(f"Invalid lifecycle state: {state}")
        payload = {
            "experiment_id": self.experiment_id,
            "state": state,
            "config_hash": self.config_hash,
            "runtime_version": self.runtime_version,
            "hardware_profile": self.hardware_profile,
            "total_items": total,
            "completed_valid_items": completed,
            "failed_items": failed,
            "corrupted_journal_lines_ignored": self.corrupted_lines_recovered,
            "reason": reason,
            "updated_utc": datetime.now(timezone.utc).isoformat(),
        }
        atomic_write_json(self.state_path, payload)

    def run_all(
        self,
        items: List[Dict[str, Any]],
        executor: Callable[[Dict[str, Any]], Tuple[bool, Dict[str, Any], Optional[str]]],
    ) -> Dict[str, Any]:
        """
        Executes all items with lock protection, resume skipping for matching valid checkpoints,
        bounded retries, immediate atomic persistence, and durable lifecycle state transitions.

        Each item dict must contain: 'sample_id', 'candidate_model', 'model_artifact_hash'.
        executor(item) -> (success: bool, result_dict: dict, error_msg: Optional[str])
        """
        with ExperimentLock(self.lock_path):
            existing = self.load_valid_checkpoints()
            results_map: Dict[str, Dict[str, Any]] = {}
            for item in items:
                sid = str(item["sample_id"])
                prev = existing.get(sid)
                if (
                    prev is not None
                    and prev.get("error_status") == "OK"
                    and prev.get("model_artifact_hash") == item["model_artifact_hash"]
                    and prev.get("candidate_model") == item["candidate_model"]
                ):
                    results_map[sid] = prev

            failed_ids = set()
            self.write_state("RUNNING", len(items), len(results_map), 0, reason="Execution active")

            try:
                for item in items:
                    sid = str(item["sample_id"])
                    if sid in results_map:
                        continue

                    last_err: Optional[str] = None
                    last_res: Dict[str, Any] = {}
                    succeeded = False
                    elapsed = 0.0

                    for attempt in range(1, self.max_retries + 1):
                        t0 = time.perf_counter()
                        try:
                            ok, res_dict, err_msg = executor(item)
                            elapsed = round(time.perf_counter() - t0, 4)
                            last_res = res_dict
                            last_err = err_msg
                            if ok:
                                succeeded = True
                                break
                        except Exception as exc:
                            elapsed = round(time.perf_counter() - t0, 4)
                            last_err = f"{type(exc).__name__}: {exc}"

                    record = {
                        "experiment_id": self.experiment_id,
                        "sample_id": sid,
                        "candidate_model": item["candidate_model"],
                        "model_artifact_hash": item["model_artifact_hash"],
                        "runtime_version": self.runtime_version,
                        "config_hash": self.config_hash,
                        "hardware_profile": self.hardware_profile,
                        "result": last_res,
                        "processing_time_sec": elapsed,
                        "error_status": "OK" if succeeded else "FAILED",
                        "error_message": None if succeeded else (last_err or "Unknown failure"),
                        "completed_utc": datetime.now(timezone.utc).isoformat(),
                    }
                    append_jsonl_durable(self.journal_path, record)
                    if succeeded:
                        results_map[sid] = record
                    else:
                        failed_ids.add(sid)
                        results_map[sid] = record

                    self.write_state(
                        "RUNNING",
                        len(items),
                        sum(1 for r in results_map.values() if r["error_status"] == "OK"),
                        len(failed_ids),
                        reason=f"Processed {sid} ({record['error_status']})",
                    )
            except KeyboardInterrupt:
                ok_cnt = sum(1 for r in results_map.values() if r["error_status"] == "OK")
                self.write_state("CANCELLED", len(items), ok_cnt, len(failed_ids), reason="Interrupted by signal")
                raise

            ok_cnt = sum(1 for r in results_map.values() if r["error_status"] == "OK")
            fail_cnt = sum(1 for r in results_map.values() if r["error_status"] != "OK")
            if ok_cnt == len(items) and fail_cnt == 0:
                final_state = "COMPLETED"
            elif ok_cnt > 0:
                final_state = "PARTIAL"
            else:
                final_state = "FAILED"
            self.write_state(final_state, len(items), ok_cnt, fail_cnt, reason="Run finished")

            ordered_records = [results_map[str(it["sample_id"])] for it in items if str(it["sample_id"]) in results_map]
            return {
                "experiment_id": self.experiment_id,
                "state": final_state,
                "config_hash": self.config_hash,
                "total_items": len(items),
                "completed_valid_items": ok_cnt,
                "failed_items": fail_cnt,
                "corrupted_journal_lines_ignored": self.corrupted_lines_recovered,
                "records": ordered_records,
            }
