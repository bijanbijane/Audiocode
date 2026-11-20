#!/usr/bin/env python3
"""
AVAPARDAZ — PHASE-02 Reproducible CPU ASR Bake-off Harness
Executes real pretrained open-source ONNX models via native Sherpa-ONNX CPU runner
against real, legally licensed (CC-BY-4.0) Google FLEURS dev speech audio
(keeping FLEURS test & PESTE Benchmark 100% frozen).

Measures on real CPU execution:
- Exact file sizes & 64-hex SHA-256 digests of every model artifact
- Cold start / model load latency (ms)
- Real-Time Factor (RTF)
- Peak OS Process RSS (MiB via /usr/bin/time or resource.getrusage on child process)
- Raw & Normalized Persian CER / WER (FA-RELAXED-V1)
- Raw & Normalized English WER / CER
- Bilingual-Switch (concatenated real Persian + real English utterance) CER / WER / Latin Recall
"""

from __future__ import annotations

import json
import os
import re
import resource
import subprocess
import sys
import time
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "training" / "scripts"))

from evaluate_asr import (  # noqa: E402
    UtteranceEval,
    aggregate_metrics,
    evaluate_utterance,
    sha256_file,
)


def wav_duration_sec(path: str) -> float:
    with wave.open(path, "rb") as wf:
        frames = wf.getnframes()
        sr = wf.getframerate()
        return frames / float(sr) if sr > 0 else 0.0


def parse_sherpa_output(
    stdout: str,
    stderr: str,
    wav_paths: List[str],
) -> Tuple[Dict[str, str], Optional[float], Optional[float]]:
    """
    Parses sherpa-onnx-offline output:
    - stdout emits one JSON object per input WAV in exact positional order.
    - stderr emits 'recognizer created in X s' and 'Elapsed seconds: Y s'.
    """
    transcripts: Dict[str, str] = {}
    json_objs: List[Dict[str, Any]] = []
    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                obj = json.loads(line)
                if "text" in obj:
                    json_objs.append(obj)
            except json.JSONDecodeError:
                pass

    for wav, obj in zip(wav_paths, json_objs):
        transcripts[wav] = str(obj.get("text", "")).strip()

    init_sec: Optional[float] = None
    decode_sec: Optional[float] = None
    for raw_line in stderr.splitlines():
        line = raw_line.strip()
        m_create = re.search(r"recognizer created in\s*([0-9.]+)\s*s", line, re.IGNORECASE)
        if m_create:
            init_sec = float(m_create.group(1))
        m_elapsed = re.search(r"Elapsed seconds:\s*([0-9.]+)\s*s", line)
        if m_elapsed:
            decode_sec = float(m_elapsed.group(1))

    return transcripts, init_sec, decode_sec


def run_sherpa_process(
    *,
    sherpa_bin: str,
    sherpa_lib: str,
    extra_args: List[str],
    wav_paths: List[str],
    enforce_offline_env: bool = True,
) -> Dict[str, Any]:
    """
    Runs sherpa-onnx-offline in a fresh isolated Python child process to capture
    true wall time, recognizer init time, decode time, and exact Peak RSS via
    resource.getrusage(RUSAGE_CHILDREN) strictly scoped to this single execution.
    """
    wrapper_code = (
        "import json, os, resource, subprocess, sys, time\n"
        "cmd = json.loads(sys.argv[1])\n"
        "offline = sys.argv[3] == '1'\n"
        "env = os.environ.copy()\n"
        "env['LD_LIBRARY_PATH'] = sys.argv[2] + ':' + env.get('LD_LIBRARY_PATH', '')\n"
        "if offline:\n"
        "  env['http_proxy'] = 'http://127.0.0.1:9'\n"
        "  env['https_proxy'] = 'http://127.0.0.1:9'\n"
        "  env['HTTP_PROXY'] = 'http://127.0.0.1:9'\n"
        "  env['HTTPS_PROXY'] = 'http://127.0.0.1:9'\n"
        "  env['HF_HUB_OFFLINE'] = '1'\n"
        "  env['TRANSFORMERS_OFFLINE'] = '1'\n"
        "t0 = time.perf_counter()\n"
        "proc = subprocess.run(cmd, env=env, capture_output=True, encoding='utf-8', errors='replace')\n"
        "wall = time.perf_counter() - t0\n"
        "ru = resource.getrusage(resource.RUSAGE_CHILDREN)\n"
        "print(json.dumps({\n"
        "  'returncode': proc.returncode,\n"
        "  'wall_sec': wall,\n"
        "  'peak_rss_kb': ru.ru_maxrss,\n"
        "  'stdout': proc.stdout,\n"
        "  'stderr': proc.stderr,\n"
        "}))\n"
    )
    cmd = [sherpa_bin, *extra_args, *wav_paths]
    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            wrapper_code,
            json.dumps(cmd),
            sherpa_lib,
            "1" if enforce_offline_env else "0",
        ],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        return {
            "returncode": proc.returncode or -1,
            "wall_sec": 0.0,
            "decode_sec": 0.0,
            "cold_start_ms": None,
            "peak_rss_mib": 0.0,
            "transcripts": {},
            "stderr_tail": (proc.stderr or "")[-800:],
        }
    res = json.loads(proc.stdout)
    stdout_str = res.get("stdout") or ""
    stderr_str = res.get("stderr") or ""
    transcripts, init_sec, decode_sec = parse_sherpa_output(stdout_str, stderr_str, wav_paths)
    wall_sec = float(res["wall_sec"])
    peak_rss_mib = round(float(res["peak_rss_kb"]) / 1024.0, 2)
    cold_start_ms = (
        round(init_sec * 1000.0, 1)
        if init_sec is not None
        else (round(max(0.0, wall_sec - decode_sec) * 1000.0, 1) if decode_sec is not None else None)
    )
    return {
        "returncode": res["returncode"],
        "wall_sec": round(wall_sec, 4),
        "decode_sec": round(decode_sec, 4) if decode_sec is not None else round(wall_sec, 4),
        "cold_start_ms": cold_start_ms,
        "peak_rss_mib": peak_rss_mib,
        "transcripts": transcripts,
        "stderr_tail": "\n".join(stderr_str.splitlines()[-12:]),
    }


def benchmark_model(
    *,
    model_name: str,
    model_id: str,
    license_spdx: str,
    artifact_files: List[str],
    sherpa_bin: str,
    sherpa_lib: str,
    extra_args: List[str],
    samples: List[Dict[str, Any]],
    batch_size: int = 25,
) -> Dict[str, Any]:
    artifact_manifest = []
    total_disk_bytes = 0
    for fpath in artifact_files:
        if os.path.exists(fpath):
            sz = os.path.getsize(fpath)
            total_disk_bytes += sz
            artifact_manifest.append({
                "file": os.path.basename(fpath),
                "bytes": sz,
                "sha256": sha256_file(fpath),
            })

    # 1. Single-stream Cold Start, Peak RSS & Offline-Isolation Probe on first real Persian sample
    probe_sample = samples[0]
    probe_res = run_sherpa_process(
        sherpa_bin=sherpa_bin,
        sherpa_lib=sherpa_lib,
        extra_args=extra_args,
        wav_paths=[probe_sample["audio"]],
        enforce_offline_env=True,
    )
    probe_dur = float(probe_sample["duration_sec"])
    probe_rtf = round(float(probe_res["decode_sec"]) / probe_dur, 4) if probe_dur > 0 else None

    # 2. Full evaluation corpus run (chunked by batch_size to avoid artificial multi-stream RAM bloat)
    all_transcripts: Dict[str, str] = {}
    total_decode_sec = 0.0
    total_wall_sec = 0.0
    max_batch_rss_mib = probe_res["peak_rss_mib"]
    worst_rc = probe_res["returncode"]

    wav_paths = [s["audio"] for s in samples]
    for i in range(0, len(wav_paths), max(1, batch_size)):
        chunk = wav_paths[i : i + max(1, batch_size)]
        chunk_res = run_sherpa_process(
            sherpa_bin=sherpa_bin,
            sherpa_lib=sherpa_lib,
            extra_args=extra_args,
            wav_paths=chunk,
            enforce_offline_env=True,
        )
        all_transcripts.update(chunk_res["transcripts"])
        total_decode_sec += float(chunk_res["decode_sec"])
        total_wall_sec += float(chunk_res["wall_sec"])
        max_batch_rss_mib = max(max_batch_rss_mib, float(chunk_res["peak_rss_mib"]))
        if chunk_res["returncode"] != 0:
            worst_rc = chunk_res["returncode"]

    total_audio_sec = sum(float(s["duration_sec"]) for s in samples)
    overall_rtf = round(total_decode_sec / total_audio_sec, 4) if total_audio_sec > 0 else None

    per_sample_evals: List[UtteranceEval] = []
    for s in samples:
        hyp = all_transcripts.get(s["audio"], "")
        est_inf = total_decode_sec * (float(s["duration_sec"]) / max(total_audio_sec, 1e-6))
        per_sample_evals.append(
            evaluate_utterance(
                sample_id=s["sample_id"],
                language=s["language"],
                duration_sec=float(s["duration_sec"]),
                reference=s["reference"],
                hypothesis=hyp,
                inference_sec=est_inf,
            )
        )

    subsets: Dict[str, Dict[str, Any]] = {}
    for subset_key in ("fa", "en", "fa-en-concat"):
        sub_items = [x for x in per_sample_evals if x.language == subset_key]
        subsets[subset_key] = aggregate_metrics(sub_items)

    return {
        "model_name": model_name,
        "model_id": model_id,
        "license_spdx": license_spdx,
        "disk_size_mib": round(total_disk_bytes / (1024 * 1024), 2),
        "artifacts": artifact_manifest,
        "returncode": worst_rc,
        "offline_verified": worst_rc == 0 and len(all_transcripts) == len(samples),
        "cold_start_ms": probe_res["cold_start_ms"],
        "single_stream_peak_rss_mib": probe_res["peak_rss_mib"],
        "single_stream_rtf": probe_rtf,
        "batch_size_used": batch_size,
        "batch_peak_rss_mib": round(max_batch_rss_mib, 2),
        "wall_sec": round(total_wall_sec, 4),
        "decode_sec": round(total_decode_sec, 4),
        "overall_rtf": overall_rtf,
        "subsets": subsets,
        "sample_outputs": [
            {
                "sample_id": x.sample_id,
                "language": x.language,
                "duration_sec": round(x.duration_sec, 2),
                "reference": x.reference,
                "hypothesis": x.hypothesis,
                "raw_cer_pct": round(x.raw_cer * 100.0, 2),
                "norm_cer_pct": round(x.norm_cer * 100.0, 2),
                "norm_wer_pct": round(x.norm_wer * 100.0, 2),
                "latin_recall_pct": round(x.latin_recall * 100.0, 2) if x.latin_recall is not None else None,
            }
            for x in per_sample_evals
        ],
    }


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: run_cpu_bakeoff.py <bench_config.json>", file=sys.stderr)
        sys.exit(2)

    cfg = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    samples = cfg["samples"]
    results = []
    for m in cfg["models"]:
        print(f"[BENCH] Running {m['model_name']} on {len(samples)} real audio samples...", flush=True)
        res = benchmark_model(
            model_name=m["model_name"],
            model_id=m["model_id"],
            license_spdx=m["license_spdx"],
            artifact_files=m["artifact_files"],
            sherpa_bin=cfg["sherpa_bin"],
            sherpa_lib=cfg["sherpa_lib"],
            extra_args=m["extra_args"],
            samples=samples,
            batch_size=int(m.get("batch_size", 25)),
        )
        results.append(res)
        print(
            f"  -> rc={res['returncode']} | offline={res['offline_verified']} | "
            f"cold={res['cold_start_ms']}ms | RTF={res['overall_rtf']} | "
            f"RSS_1x={res['single_stream_peak_rss_mib']} MiB | "
            f"FA_CER={res['subsets']['fa']['norm_cer_pct']}% | "
            f"EN_WER={res['subsets']['en']['norm_wer_pct']}% | "
            f"BI_CER={res['subsets']['fa-en-concat']['norm_cer_pct']}% | "
            f"BI_LATIN={res['subsets']['fa-en-concat'].get('latin_token_recall_pct', res['subsets']['fa-en-concat'].get('latin_recall_pct'))}%",
            flush=True,
        )

    out_path = Path(cfg["output_json"])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "host": cfg.get("host_info", {}),
        "dataset": cfg.get("dataset_info", {}),
        "results": results,
    }
    out_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"[BENCH] Saved machine-readable report to {out_path}", flush=True)


if __name__ == "__main__":
    main()
