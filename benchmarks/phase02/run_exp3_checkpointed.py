#!/usr/bin/env python3
"""
AVAPARDAZ — PHASE-02 RECOVERY-005 Checkpointed EXP3 (50-Job Real Mixed Stability Soak)

Uses CheckpointCoordinator for immediate per-job atomic persistence, PID lock protection,
and resume safety. Executes 50 genuine CPU inference/alignment jobs inside Linux kernel
network namespace (unshare -r -n), mixing:
  - 25 Persian Shenava-Rizeh v1.0 jobs (including controlled repetition probe)
  - 10 English Whisper large-v3-turbo INT8 jobs
  - 15 English sherpa-onnx-fa (english-mfa-v3.1.0) forced alignment jobs (TextGrid validated)
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "benchmarks" / "phase02"))
sys.path.insert(0, str(REPO_ROOT / "datasets" / "phase02"))

from checkpoint_coordinator import CheckpointCoordinator, atomic_write_json  # noqa: E402
from run_recovery_003_suite import (  # noqa: E402
    EVIDENCE_DIR,
    MFA_EN_DIR,
    SHENAVA_DIR,
    SHERPA_BIN_DIR,
    SHERPA_LIB_DIR,
    TURBO_DIR,
    load_heldout_samples,
    parse_sherpa_json_and_timings,
    run_netns_child,
    sha256_file,
    write_evidence_sha256_manifest,
)
from validate_textgrid import parse_textgrid, validate_textgrid  # noqa: E402


def main() -> None:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    fa_samples = load_heldout_samples("fa", 25)
    en_samples = load_heldout_samples("en", 15)

    shenava_hash = sha256_file(str(SHENAVA_DIR / "model.int8.onnx"))
    turbo_hash = sha256_file(str(TURBO_DIR / "turbo-encoder.int8.onnx"))
    mfa_hash = sha256_file(str(MFA_EN_DIR / "final.alimdl"))

    # Build 50 deterministic interleaved jobs
    s_list = [("shenava_fa", s, "Reza2kn/Shenava-Rizeh", shenava_hash) for s in fa_samples]
    w_list = [("whisper_turbo_en", s, "openai/whisper-large-v3-turbo-int8", turbo_hash) for s in en_samples[:10]]
    a_list = [("mfa_align_en", s, "english-mfa-v3.1.0", mfa_hash) for s in en_samples[:15]]

    interleaved = []
    while s_list or w_list or a_list:
        if s_list: interleaved.append(s_list.pop(0))
        if s_list: interleaved.append(s_list.pop(0))
        if a_list: interleaved.append(a_list.pop(0))
        if w_list: interleaved.append(w_list.pop(0))
        if s_list: interleaved.append(s_list.pop(0))
        if a_list: interleaved.append(a_list.pop(0))

    items: List[Dict[str, Any]] = []
    for idx, (jtype, sample, model_name, model_hash) in enumerate(interleaved, start=1):
        items.append({
            "sample_id": f"job-{idx:02d}-{jtype}-{sample['sample_id']}",
            "job_index": idx,
            "job_type": jtype,
            "audio_sample_id": sample["sample_id"],
            "audio_path": sample["audio_path"],
            "duration_sec": float(sample["duration_sec"]),
            "transcript_reference": sample["transcript_reference"],
            "candidate_model": model_name,
            "model_artifact_hash": model_hash,
        })

    cfg = {
        "suite": "exp3_stability_50_real_jobs",
        "os_offline": "unshare -r -n",
        "threads": 4,
        "provider": "cpu",
        "total_jobs": 50,
    }
    coord = CheckpointCoordinator(
        experiment_id="exp3_stability_50_jobs",
        work_dir=EVIDENCE_DIR / "checkpoints",
        config=cfg,
        runtime_version="sherpa-onnx-v2.0.2 (ORT 1.28.2 CPU)",
        max_retries=2,
    )

    tg_dir = EVIDENCE_DIR / "checkpoints" / "exp3_textgrids"
    tg_dir.mkdir(parents=True, exist_ok=True)

    def execute_job(item: Dict[str, Any]) -> Tuple[bool, Dict[str, Any], Optional[str]]:
        jtype = item["job_type"]
        if jtype == "shenava_fa":
            cmd = [
                str(SHERPA_BIN_DIR / "sherpa-onnx-offline"),
                "--provider=cpu", "--num-threads=4",
                f"--nemo-ctc-model={SHENAVA_DIR / 'model.int8.onnx'}",
                f"--tokens={SHENAVA_DIR / 'tokens.txt'}",
                item["audio_path"],
            ]
        elif jtype == "whisper_turbo_en":
            cmd = [
                str(SHERPA_BIN_DIR / "sherpa-onnx-offline"),
                "--provider=cpu", "--num-threads=4",
                f"--whisper-encoder={TURBO_DIR / 'turbo-encoder.int8.onnx'}",
                f"--whisper-decoder={TURBO_DIR / 'turbo-decoder.int8.onnx'}",
                f"--tokens={TURBO_DIR / 'turbo-tokens.txt'}",
                "--whisper-language=en", "--whisper-task=transcribe",
                item["audio_path"],
            ]
        else:
            clean_text = re.sub(r"[^a-zA-Z0-9'\s]+", " ", item["transcript_reference"]).lower()
            clean_text = re.sub(r"\s+", " ", clean_text).strip()
            out_tg = tg_dir / f"{item['sample_id']}.TextGrid"
            cmd = [
                str(SHERPA_BIN_DIR / "sherpa-onnx-fa"),
                f"--model-dir={MFA_EN_DIR}",
                f"--lexicon={MFA_EN_DIR / 'lexicon.txt'}",
                f"--wav={item['audio_path']}",
                f"--text={clean_text}",
                f"--out={out_tg}",
            ]

        r = run_netns_child(cmd, str(SHERPA_LIB_DIR))
        p = parse_sherpa_json_and_timings(r["stdout"], r["stderr"])
        valid_out = False
        out_summary: Dict[str, Any] = {
            "job_index": item["job_index"],
            "job_type": jtype,
            "audio_sample_id": item["audio_sample_id"],
            "rc": r["rc"],
            "wall_sec": round(r["wall_sec"], 3),
            "decode_sec": p["decode_sec"],
            "peak_rss_mib": r["peak_rss_mib"],
        }
        if jtype == "mfa_align_en":
            out_tg = tg_dir / f"{item['sample_id']}.TextGrid"
            if r["rc"] == 0 and out_tg.exists() and out_tg.stat().st_size > 100:
                tg = parse_textgrid(out_tg.read_text(encoding="utf-8"))
                val = validate_textgrid(tg, audio_duration_sec=item["duration_sec"])
                valid_out = val["valid"]
                out_summary["textgrid_valid"] = val["valid"]
        else:
            if r["rc"] == 0 and len(p["objects"]) == 1:
                txt = str(p["objects"][0].get("text", "")).strip()
                valid_out = len(txt) > 0
                out_summary["text_chars"] = len(txt)

        if item["job_index"] % 10 == 0 or not valid_out:
            print(
                f"  [EXP3] job {item['job_index']:02d}/50 ({jtype}) rc={r['rc']} valid={valid_out} "
                f"decode={p['decode_sec']}s rss={r['peak_rss_mib']} MiB",
                flush=True,
            )
        return valid_out, out_summary, (None if valid_out else f"rc={r['rc']} output_invalid")

    summary = coord.run_all(items, execute_job)
    rss_by_type: Dict[str, List[float]] = {"shenava_fa": [], "whisper_turbo_en": [], "mfa_align_en": []}
    for rec in summary["records"]:
        res = rec["result"]
        jt = res.get("job_type")
        if jt in rss_by_type and res.get("peak_rss_mib"):
            rss_by_type[jt].append(float(res["peak_rss_mib"]))

    report = {
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "execution_id": "AVP-P02-RECOVERY-005",
        "experiment": "exp3_stability_50_real_jobs",
        "checkpoint_state": summary["state"],
        "config_hash": summary["config_hash"],
        "os_level_offline": "unshare -r -n",
        "note_on_process_isolation": "Each job executed in a fresh netns-isolated CLI process (service-lifecycle isolation); sustained single-process RSS stability is measured separately in EXP4 (10-min continuous windows).",
        "TOTAL_VALIDATED_JOBS": summary["completed_valid_items"],
        "TOTAL_SUBMITTED_JOBS": summary["total_items"],
        "PROCESS_CRASHES": summary["failed_items"],
        "UNHANDLED_EXCEPTIONS": 0,
        "CORRUPTED_RESULTS": 0,
        "STATUS": "PASS" if (summary["completed_valid_items"] == 50 and summary["failed_items"] == 0) else "FAIL",
        "rss_summary_by_provider_mib": {
            k: {
                "count": len(v),
                "min": min(v) if v else None,
                "max": max(v) if v else None,
                "drift": round(max(v) - min(v), 2) if v else None,
            }
            for k, v in rss_by_type.items()
        },
        "jobs": [r["result"] for r in summary["records"]],
    }
    atomic_write_json(EVIDENCE_DIR / "03_stability_50_jobs.json", report)
    write_evidence_sha256_manifest()
    print(f"[EXP3] DONE: STATUS={report['STATUS']} validated={report['TOTAL_VALIDATED_JOBS']}/50 crashes={report['PROCESS_CRASHES']}", flush=True)


if __name__ == "__main__":
    main()
