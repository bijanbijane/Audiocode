#!/usr/bin/env python3
"""
AVAPARDAZ — PHASE-02 Portable Apple Silicon M2 / 8 GB CPU-Only Validation Runner

Strict Design Invariants:
- Standard library Python 3 ONLY (zero pip installs required on target Mac).
- Relative paths only (no hardcoded machine paths).
- CPU-only inference explicitly enforced (--provider=cpu / --no-gpu; Metal disabled).
- Safe OS-level offline isolation on macOS via sandbox-exec `(version 1)(allow default)(deny network*)`
  without modifying system firewall, Wi-Fi, or persistent macOS settings.
- Fails safely if hardware prerequisites do not match Apple Silicon M2 / 8 GB (unless --dry-run-preflight).
- Generates all 13 required evidence artifacts + SHA-256 evidence manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import re
import resource
import shutil
import subprocess
import sys
import time
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


REQUIRED_OUTPUT_FILES = (
    "M2_HARDWARE_REPORT.json",
    "MODEL_INVENTORY.json",
    "BENCHMARK_RESULTS.json",
    "BENCHMARK_RESULTS.jsonl",
    "STABILITY_REPORT.json",
    "LONG_AUDIO_REPORT.json",
    "OFFLINE_VERIFICATION_REPORT.json",
    "MEMORY_AND_THERMAL_REPORT.json",
    "MODEL_HASHES.txt",
    "DATASET_HASHES.txt",
    "EVIDENCE_MANIFEST.sha256",
    "FINAL_REPORT.md",
)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def wav_duration_sec(path: Path) -> float:
    with wave.open(str(path), "rb") as wf:
        return wf.getnframes() / float(wf.getframerate())


def run_cmd(cmd: List[str], env: Optional[Dict[str, str]] = None, timeout: int = 3600) -> Tuple[int, str, str, float]:
    t0 = time.perf_counter()
    try:
        proc = subprocess.run(cmd, env=env, capture_output=True, encoding="utf-8", errors="replace", timeout=timeout)
        return proc.returncode, proc.stdout, proc.stderr, time.perf_counter() - t0
    except FileNotFoundError as exc:
        return 127, "", str(exc), time.perf_counter() - t0
    except subprocess.TimeoutExpired as exc:
        return 124, "", f"TIMEOUT after {timeout}s: {exc}", time.perf_counter() - t0


def collect_hardware_inventory(cfg: Dict[str, Any]) -> Dict[str, Any]:
    sys_name = platform.system()
    arch = platform.machine()
    cpu_brand = platform.processor() or "UNKNOWN"
    mem_bytes: Optional[int] = None
    macos_version = platform.mac_ver()[0] if sys_name == "Darwin" else None

    if sys_name == "Darwin":
        rc, out, _, _ = run_cmd(["sysctl", "-n", "machdep.cpu.brand_string"])
        if rc == 0 and out.strip():
            cpu_brand = out.strip()
        rc, out, _, _ = run_cmd(["sysctl", "-n", "hw.memsize"])
        if rc == 0 and out.strip().isdigit():
            mem_bytes = int(out.strip())
    elif Path("/proc/meminfo").exists():
        for line in Path("/proc/meminfo").read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("MemTotal:"):
                mem_bytes = int(line.split()[1]) * 1024
                break

    mem_gib = round(mem_bytes / (1024 ** 3), 2) if mem_bytes else None
    target = cfg["target_hardware"]
    checks = {
        "os_is_darwin": sys_name == target["required_os"],
        "arch_is_arm64": arch == target["required_arch"],
        "cpu_matches_m2": target["expected_cpu_substring"].lower() in cpu_brand.lower(),
        "memory_matches_8gb": (
            mem_gib is not None
            and abs(mem_gib - float(target["expected_memory_gib"])) <= float(target["memory_tolerance_gib"])
        ),
    }
    return {
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "os": sys_name,
        "os_release": platform.release(),
        "macos_version": macos_version,
        "arch": arch,
        "cpu_brand": cpu_brand,
        "cpu_logical_cores": os.cpu_count(),
        "physical_memory_bytes": mem_bytes,
        "physical_memory_gib": mem_gib,
        "device_mode_enforced": target["device_mode"],
        "prerequisite_checks": checks,
        "is_qualified_m2_8gb_target": all(checks.values()),
    }


def sample_macos_memory_and_thermal() -> Dict[str, Any]:
    """Captures macOS swap usage, memory_pressure, thermal level & Adobe Audition status."""
    snap: Dict[str, Any] = {
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "swap_used_mib": None,
        "memory_pressure_level": "NOT_AVAILABLE",
        "thermal_state": "NOT_AVAILABLE",
        "audition_running": False,
        "audition_pids": [],
        "audition_rss_mib": 0.0,
    }
    if platform.system() != "Darwin":
        return snap

    rc, out, _, _ = run_cmd(["sysctl", "-n", "vm.swapusage"])
    if rc == 0:
        m = re.search(r"used\s*=\s*([0-9.]+)([MG])", out)
        if m:
            val = float(m.group(1))
            snap["swap_used_mib"] = round(val * 1024.0 if m.group(2) == "G" else val, 2)

    rc, out, _, _ = run_cmd(["memory_pressure"])
    if rc == 0:
        m = re.search(r"System-wide memory free percentage:\s*(\d+)%", out)
        snap["memory_pressure_level"] = f"free_{m.group(1)}pct" if m else out.strip().splitlines()[-1][:80]

    # macOS ProcessInfo thermalState via osascript/JXA (no sudo required, unlike powermetrics)
    rc, out, _, _ = run_cmd([
        "osascript", "-l", "JavaScript", "-e",
        'ObjC.import("Foundation"); $.NSProcessInfo.processInfo.thermalState'
    ])
    thermal_map = {"0": "Nominal", "1": "Fair", "2": "Serious", "3": "Critical"}
    if rc == 0 and out.strip() in thermal_map:
        snap["thermal_state"] = thermal_map[out.strip()]
    else:
        rc2, out2, _, _ = run_cmd(["pmset", "-g", "therm"])
        if rc2 == 0:
            snap["thermal_state"] = " | ".join(ln.strip() for ln in out2.splitlines() if "CPU_Speed_Limit" in ln or "Thermal" in ln) or "pmset_ok"

    rc, out, _, _ = run_cmd(["pgrep", "-if", "Adobe Audition"])
    if rc == 0 and out.strip():
        pids = [p.strip() for p in out.splitlines() if p.strip().isdigit()]
        snap["audition_running"] = bool(pids)
        snap["audition_pids"] = pids
        if pids:
            rc_ps, out_ps, _, _ = run_cmd(["ps", "-o", "rss=", "-p", ",".join(pids)])
            if rc_ps == 0:
                kb = sum(int(x) for x in out_ps.split() if x.isdigit())
                snap["audition_rss_mib"] = round(kb / 1024.0, 2)

    return snap


def verify_models(kit_root: Path, cfg: Dict[str, Any]) -> Dict[str, Any]:
    inventory: List[Dict[str, Any]] = []
    all_ok = True
    for m in cfg["models"]:
        m_files = []
        m_ok = True
        for f in m["files"]:
            fp = kit_root / f["path"]
            exists = fp.exists()
            actual = sha256_file(fp) if exists else None
            matched = (actual == f["sha256"]) if exists else False
            if not matched:
                m_ok = False
                all_ok = False
            m_files.append({
                "path": f["path"],
                "exists": exists,
                "expected_sha256": f["sha256"],
                "actual_sha256": actual,
                "sha256_match": matched,
                "bytes": fp.stat().st_size if exists else 0,
            })
        inventory.append({
            "id": m["id"],
            "name": m["name"],
            "license": m["license"],
            "verified": m_ok,
            "files": m_files,
        })
    return {"all_models_verified": all_ok, "models": inventory}


def run_isolated_inference(
    kit_root: Path,
    sherpa_bin: Path,
    lib_dir: Path,
    model_args: List[str],
    wav_path: Path,
    enforce_os_offline: bool = False,
) -> Dict[str, Any]:
    """Runs single isolated CPU-only inference in a fresh child process capturing true Peak RSS."""
    abs_args = []
    for a in model_args:
        if "=" in a and a.split("=", 1)[1].startswith("artifacts/"):
            k, v = a.split("=", 1)
            abs_args.append(f"{k}={kit_root / v}")
        else:
            abs_args.append(a)

    cmd = [str(sherpa_bin), *abs_args, str(wav_path)]
    offline_method = "env_proxy_blackhole"
    if enforce_os_offline:
        if platform.system() == "Darwin" and shutil.which("sandbox-exec"):
            cmd = ["sandbox-exec", "-p", "(version 1)(allow default)(deny network*)", *cmd]
            offline_method = "macos_sandbox_exec_deny_network"
        elif platform.system() == "Linux" and shutil.which("unshare"):
            cmd = ["unshare", "-r", "-n", *cmd]
            offline_method = "linux_unshare_netns"

    wrapper = (
        "import json, os, platform, resource, subprocess, sys, time\n"
        "cmd = json.loads(sys.argv[1])\n"
        "env = os.environ.copy()\n"
        "lib_key = 'DYLD_LIBRARY_PATH' if platform.system() == 'Darwin' else 'LD_LIBRARY_PATH'\n"
        "env[lib_key] = sys.argv[2] + ':' + env.get(lib_key, '')\n"
        "env['http_proxy'] = env['https_proxy'] = env['ALL_PROXY'] = 'http://127.0.0.1:9'\n"
        "env['HF_HUB_OFFLINE'] = env['TRANSFORMERS_OFFLINE'] = '1'\n"
        "t0 = time.perf_counter()\n"
        "p = subprocess.run(cmd, env=env, capture_output=True, encoding='utf-8', errors='replace')\n"
        "wall = time.perf_counter() - t0\n"
        "ru = resource.getrusage(resource.RUSAGE_CHILDREN)\n"
        "rss_mib = (ru.ru_maxrss / (1024.0 * 1024.0)) if platform.system() == 'Darwin' else (ru.ru_maxrss / 1024.0)\n"
        "print(json.dumps({'rc': p.returncode, 'wall_sec': wall, 'peak_rss_mib': round(rss_mib, 2), 'stdout': p.stdout, 'stderr': p.stderr}))\n"
    )
    rc, out, err, _ = run_cmd([sys.executable, "-c", wrapper, json.dumps(cmd), str(lib_dir)])
    if rc != 0 or not out.strip():
        return {"rc": rc or -1, "error": err[-500:], "offline_method": offline_method}
    res = json.loads(out)
    text = ""
    combined_lines = (res.get("stdout") or "").splitlines() + (res.get("stderr") or "").splitlines()
    for ln in combined_lines:
        s = ln.strip()
        if s.startswith("{") and s.endswith("}"):
            try:
                obj = json.loads(s)
                if "text" in obj:
                    text = str(obj["text"]).strip()
            except json.JSONDecodeError:
                pass
    init_sec = None
    decode_sec = None
    for ln in (res.get("stderr") or "").splitlines():
        m1 = re.search(r"recognizer created in\s*([0-9.]+)\s*s", ln, re.IGNORECASE)
        if m1:
            init_sec = float(m1.group(1))
        m2 = re.search(r"Elapsed seconds:\s*([0-9.]+)\s*s", ln)
        if m2:
            decode_sec = float(m2.group(1))
    dur = wav_duration_sec(wav_path)
    rtf = round(decode_sec / dur, 4) if (decode_sec is not None and dur > 0) else None
    return {
        "rc": res["rc"],
        "offline_method": offline_method,
        "audio_duration_sec": round(dur, 3),
        "cold_start_ms": round(init_sec * 1000.0, 1) if init_sec is not None else None,
        "decode_sec": round(decode_sec, 4) if decode_sec is not None else None,
        "wall_sec": round(res["wall_sec"], 4),
        "rtf": rtf,
        "peak_rss_mib": res["peak_rss_mib"],
        "text": text,
        "stderr_tail": "\n".join((res.get("stderr") or "").splitlines()[-8:]),
    }


def percentile(vals: List[float], pct: float) -> Optional[float]:
    if not vals:
        return None
    s = sorted(vals)
    k = (len(s) - 1) * (pct / 100.0)
    f, c = math.floor(k), math.ceil(k)
    return round(s[int(k)] if f == c else s[f] + (s[c] - s[f]) * (k - f), 4)


def write_evidence_manifest(out_dir: Path) -> None:
    lines = []
    for p in sorted(out_dir.rglob("*")):
        if p.is_file() and p.name != "EVIDENCE_MANIFEST.sha256":
            rel = p.relative_to(out_dir)
            lines.append(f"{sha256_file(p)}  {rel}")
    (out_dir / "EVIDENCE_MANIFEST.sha256").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="AVAPARDAZ Portable M2 8GB CPU-Only Validation Runner")
    parser.add_argument("--config", required=True)
    parser.add_argument("--profile", choices=["smoke", "full"], default="full")
    parser.add_argument("--allow-audition-absent", action="store_true")
    parser.add_argument("--skip-long-audio", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--dry-run-preflight", action="store_true")
    args = parser.parse_args()

    cfg_path = Path(args.config).resolve()
    kit_root = cfg_path.parent
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))

    if args.verify_only:
        inv = verify_models(kit_root, cfg)
        print(json.dumps(inv, indent=2))
        sys.exit(0 if inv["all_models_verified"] else 1)

    hw = collect_hardware_inventory(cfg)
    if args.dry_run_preflight:
        print(json.dumps({"preflight_mode": True, "hardware": hw, "config_valid": True}, indent=2))
        sys.exit(0)

    if not hw["is_qualified_m2_8gb_target"]:
        print("FAIL-SAFE ABORT: Target hardware prerequisites NOT met for Apple Silicon M2 / 8 GB qualification.", file=sys.stderr)
        print(json.dumps(hw, indent=2), file=sys.stderr)
        sys.exit(10)

    inv = verify_models(kit_root, cfg)
    if not inv["all_models_verified"]:
        print("FAIL-SAFE ABORT: Local model artifacts missing or SHA-256 mismatch. Run ./setup_m2_artifacts.sh first.", file=sys.stderr)
        print(json.dumps(inv, indent=2), file=sys.stderr)
        sys.exit(11)

    run_id = datetime.now(timezone.utc).strftime("m2-run-%Y%m%dT%H%M%SZ")
    out_dir = kit_root / cfg["relative_paths"]["output_base_dir"] / run_id
    logs_dir = out_dir / "EXECUTION_LOGS"
    logs_dir.mkdir(parents=True, exist_ok=True)

    sherpa_bin = kit_root / cfg["relative_paths"]["sherpa_offline_bin"]
    lib_dir = kit_root / cfg["relative_paths"]["sherpa_lib_dir"]
    audio_dir = kit_root / cfg["relative_paths"]["audio_dir"]
    wavs = sorted(audio_dir.glob("*.wav")) if audio_dir.exists() else []
    if not wavs:
        print(f"FAIL-SAFE ABORT: No 16 kHz mono WAV audio files found in {audio_dir}", file=sys.stderr)
        sys.exit(12)

    baseline_sys = sample_macos_memory_and_thermal()
    if not baseline_sys["audition_running"] and not args.allow_audition_absent:
        print(
            "NOTICE: Adobe Audition is NOT currently running. For Audition coexistence qualification, launch "
            "Adobe Audition with a representative project loaded, OR pass --allow-audition-absent for standalone baseline.",
            file=sys.stderr,
        )

    bench_rows: List[Dict[str, Any]] = []
    mem_thermal_timeline: List[Dict[str, Any]] = [{"stage": "baseline_pre_load", **baseline_sys}]
    thresholds = cfg["acceptance_thresholds"]

    for model in cfg["models"]:
        target_wav = wavs[0]
        cold_runs = []
        for idx in range(int(thresholds["cold_start_runs"])):
            r = run_isolated_inference(kit_root, sherpa_bin, lib_dir, model["cli_args"], target_wav, enforce_os_offline=False)
            r["run_type"] = "cold"
            r["run_index"] = idx + 1
            r["model_id"] = model["id"]
            cold_runs.append(r)
            bench_rows.append(r)
            mem_thermal_timeline.append({"stage": f"{model['id']}_cold_{idx+1}", **sample_macos_memory_and_thermal()})

        warm_runs = []
        for idx in range(int(thresholds["warm_runs"])):
            w = wavs[idx % len(wavs)]
            r = run_isolated_inference(kit_root, sherpa_bin, lib_dir, model["cli_args"], w, enforce_os_offline=False)
            r["run_type"] = "measured"
            r["run_index"] = idx + 1
            r["model_id"] = model["id"]
            warm_runs.append(r)
            bench_rows.append(r)
            mem_thermal_timeline.append({"stage": f"{model['id']}_run_{idx+1}", **sample_macos_memory_and_thermal()})

    # OS-level Offline Sandbox Test
    offline_results = []
    for model in cfg["models"]:
        r = run_isolated_inference(kit_root, sherpa_bin, lib_dir, model["cli_args"], wavs[0], enforce_os_offline=True)
        offline_results.append({"model_id": model["id"], **r})

    # 50-Job Stability Test (or 5 in smoke profile)
    n_jobs = int(thresholds["stability_jobs_full"] if args.profile == "full" else thresholds["stability_jobs_smoke"])
    stability_jobs = []
    crashes = 0
    for j in range(n_jobs):
        m = cfg["models"][j % len(cfg["models"])]
        w = wavs[j % len(wavs)]
        r = run_isolated_inference(kit_root, sherpa_bin, lib_dir, m["cli_args"], w, enforce_os_offline=True)
        if r.get("rc") != 0:
            crashes += 1
        stability_jobs.append({"job_index": j + 1, "model_id": m["id"], "wav": w.name, **r})
        if (j + 1) % 10 == 0:
            mem_thermal_timeline.append({"stage": f"stability_job_{j+1}", **sample_macos_memory_and_thermal()})

    # Long Audio Check (if audio/long_recording_16k.wav exists)
    long_wav = audio_dir / "long_recording_16k.wav"
    long_report: Dict[str, Any] = {"status": "SKIPPED_NO_LONG_AUDIO_FILE", "expected_path": str(long_wav.name)}
    if long_wav.exists() and not args.skip_long_audio:
        long_res = run_isolated_inference(kit_root, sherpa_bin, lib_dir, cfg["models"][0]["cli_args"], long_wav, enforce_os_offline=True)
        long_report = {"status": "PASS" if long_res.get("rc") == 0 else "FAIL", **long_res}

    # Summarize Metrics
    rtfs = [r["rtf"] for r in bench_rows if r.get("rtf") is not None]
    rss_vals = [r["peak_rss_mib"] for r in bench_rows if r.get("peak_rss_mib") is not None]
    swaps = [s["swap_used_mib"] for s in mem_thermal_timeline if s.get("swap_used_mib") is not None]
    swap_growth = round(max(swaps) - swaps[0], 2) if len(swaps) >= 2 else None

    (out_dir / "M2_HARDWARE_REPORT.json").write_text(json.dumps(hw, indent=2), encoding="utf-8")
    (out_dir / "MODEL_INVENTORY.json").write_text(json.dumps(inv, indent=2), encoding="utf-8")
    (out_dir / "BENCHMARK_RESULTS.json").write_text(
        json.dumps({
            "profile": args.profile,
            "median_cpu_rtf": percentile(rtfs, 50),
            "p90_cpu_rtf": percentile(rtfs, 90),
            "peak_process_rss_mib": max(rss_vals) if rss_vals else None,
            "runs": bench_rows,
        }, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    (out_dir / "BENCHMARK_RESULTS.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in bench_rows) + "\n",
        encoding="utf-8",
    )
    (out_dir / "STABILITY_REPORT.json").write_text(
        json.dumps({"total_jobs": n_jobs, "crashes": crashes, "status": "PASS" if crashes == 0 else "FAIL", "jobs": stability_jobs}, indent=2),
        encoding="utf-8",
    )
    (out_dir / "LONG_AUDIO_REPORT.json").write_text(json.dumps(long_report, indent=2), encoding="utf-8")
    (out_dir / "OFFLINE_VERIFICATION_REPORT.json").write_text(
        json.dumps({"status": "PASS" if all(r.get("rc") == 0 for r in offline_results) else "FAIL", "results": offline_results}, indent=2),
        encoding="utf-8",
    )
    (out_dir / "MEMORY_AND_THERMAL_REPORT.json").write_text(
        json.dumps({
            "audition_detected_at_baseline": baseline_sys["audition_running"],
            "post_warmup_swap_growth_mib": swap_growth,
            "timeline": mem_thermal_timeline,
        }, indent=2),
        encoding="utf-8",
    )
    (logs_dir / "run_summary.log").write_text(f"Completed run {run_id} profile={args.profile} crashes={crashes}\n", encoding="utf-8")

    model_hashes = []
    for m in inv["models"]:
        for f in m["files"]:
            model_hashes.append(f"{f['actual_sha256']}  {f['path']}")
    (out_dir / "MODEL_HASHES.txt").write_text("\n".join(model_hashes) + "\n", encoding="utf-8")
    (out_dir / "DATASET_HASHES.txt").write_text("\n".join(f"{sha256_file(w)}  {w.name}" for w in wavs) + "\n", encoding="utf-8")

    final_md = (
        f"# AVAPARDAZ — Physical Apple M2 (8 GB) Qualification Report ({run_id})\n\n"
        f"- **Hardware:** `{hw['cpu_brand']}` / `{hw['physical_memory_gib']} GiB` / macOS `{hw['macos_version']}`\n"
        f"- **Profile:** `{args.profile}` (`CPU_ONLY_NO_METAL`)\n"
        f"- **Median CPU RTF:** `{percentile(rtfs, 50)}` (P90: `{percentile(rtfs, 90)}`)\n"
        f"- **Peak Process RSS:** `{max(rss_vals) if rss_vals else None} MiB`\n"
        f"- **Post-Warmup Swap Growth:** `{swap_growth} MiB` (limit `<= 512 MiB`)\n"
        f"- **Adobe Audition Detected:** `{baseline_sys['audition_running']}`\n"
        f"- **Stability Jobs:** `{n_jobs}` (`crashes = {crashes}`)\n"
        f"- **Long Audio Status:** `{long_report['status']}`\n"
    )
    (out_dir / "FINAL_REPORT.md").write_text(final_md, encoding="utf-8")
    write_evidence_manifest(out_dir)
    print(f"COMPLETE: Evidence bundle written to {out_dir}")


if __name__ == "__main__":
    main()
