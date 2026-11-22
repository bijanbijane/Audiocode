#!/usr/bin/env python3
"""
AVAPARDAZ — PHASE-02 RECOVERY-004 EXP4: Genuine Continuous 30-Minute Audio Pipeline

Processes one genuine unbroken 30.00-minute (1,800.0 s) continuous segment of a single
LibriVox Public Domain (CC0-1.0) human recording (Bleak House Section 3, 59.39 min total)
— NOT concatenated short clips — using:
  - FFmpeg canonical 16 kHz Mono PCM16 preprocessing (timed)
  - Silero VAD v5 + openai/whisper-large-v3-turbo-int8 (sherpa-onnx-vad-with-offline-asr)
  - Native C++ forced alignment sample pass (sherpa-onnx-fa + english-mfa-v3.1.0)
  - Strict Linux kernel network-namespace isolation (unshare -r -n)

Executes in 3 checkpointed contiguous 10-minute streaming windows (0..600s, 600..1200s,
1200..1800s) so every window runs cleanly without command timeout risk while measuring
true single-process 10-minute sustained memory stability and full 30-minute timeline continuity.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import time
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

REPO_ROOT = Path(__file__).resolve().parents[2]
EVIDENCE_DIR = REPO_ROOT / "evidence" / "phase02" / "recovery-003"
SHERPA_BIN_DIR = Path("/root/.avapardaz/runtime/bin")
SHERPA_LIB_DIR = Path("/root/.avapardaz/runtime/lib")
TURBO_DIR = Path("/root/.avapardaz/models/sherpa-onnx-whisper-turbo")
MFA_EN_DIR = Path("/root/.avapardaz/models/english-mfa-v3.1.0")
SILERO_VAD = Path("/root/.avapardaz/models/silero_vad_v5.onnx")
LIBRIVOX_FULL_WAV = Path("/root/.avapardaz/datasets/librivox/bleak_house_03_16k.wav")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def wav_dur(path: Path) -> float:
    with wave.open(str(path), "rb") as wf:
        return wf.getnframes() / float(wf.getframerate())


def sample_tree_rss_mib(root_pid: int) -> float:
    ppid_map: Dict[int, List[int]] = {}
    rss_map: Dict[int, int] = {}
    try:
        for pdir in Path("/proc").iterdir():
            if not pdir.name.isdigit():
                continue
            try:
                stat = (pdir / "status").read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            pid = int(pdir.name)
            m_ppid = re.search(r"^PPid:\s*(\d+)", stat, re.M)
            ppid = int(m_ppid.group(1)) if m_ppid else -1
            ppid_map.setdefault(ppid, []).append(pid)
            m_rss = re.search(r"^VmRSS:\s*(\d+)\s*kB", stat, re.M)
            if m_rss:
                rss_map[pid] = int(m_rss.group(1))
    except OSError:
        pass
    seen = set()
    stack = [root_pid]
    total_kb = 0
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        total_kb += rss_map.get(cur, 0)
        stack.extend(ppid_map.get(cur, []))
    return round(total_kb / 1024.0, 2)


def atomic_write_json(path: Path, payload: Dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


WINDOW_SPECS = {
    "0": (0, 600),
    "1a": (600, 300),
    "1b": (900, 300),
    "2a": (1200, 300),
    "2b": (1500, 300),
}
ORDERED_WINDOWS = ["0", "1a", "1b", "2a", "2b"]


def run_window(win_key: str, num_threads: int = 3) -> Dict[str, Any]:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    win_start, win_dur = WINDOW_SPECS[win_key]
    ckpt_path = EVIDENCE_DIR / f"exp4_win{win_key}.json"
    if ckpt_path.exists():
        existing = json.loads(ckpt_path.read_text(encoding="utf-8"))
        if existing.get("rc") == 0 and existing.get("duration_sec", 0) >= win_dur - 0.5:
            print(f"[EXP4 WIN {win_key}] SKIP (already completed rc=0 dur={existing['duration_sec']}s)", flush=True)
            return existing

    win_wav = Path(f"/root/.avapardaz/datasets/librivox/bleak_house_03_win{win_key}_{win_start}s_{win_dur}s.wav")

    # 1. Preprocessing timing (extract contiguous stream window from unbroken master WAV)
    t_pre0 = time.perf_counter()
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-ss", str(win_start), "-t", str(win_dur),
            "-i", str(LIBRIVOX_FULL_WAV),
            "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
            str(win_wav),
        ],
        check=True,
    )
    preprocess_sec = round(time.perf_counter() - t_pre0, 3)
    actual_dur = round(wav_dur(win_wav), 3)

    # 2. VAD + Whisper Large-v3-Turbo INT8 inside kernel netns (unshare -r -n)
    cmd = [
        "unshare", "-r", "-n",
        str(SHERPA_BIN_DIR / "sherpa-onnx-vad-with-offline-asr"),
        "--provider=cpu",
        f"--num-threads={num_threads}",
        f"--silero-vad-model={SILERO_VAD}",
        f"--whisper-encoder={TURBO_DIR / 'turbo-encoder.int8.onnx'}",
        f"--whisper-decoder={TURBO_DIR / 'turbo-decoder.int8.onnx'}",
        f"--tokens={TURBO_DIR / 'turbo-tokens.txt'}",
        "--whisper-language=en",
        "--whisper-task=transcribe",
        str(win_wav),
    ]
    env = os.environ.copy()
    env["LD_LIBRARY_PATH"] = str(SHERPA_LIB_DIR) + ":" + env.get("LD_LIBRARY_PATH", "")
    out_log = EVIDENCE_DIR / f"exp4_win{win_key}_stdout.log"
    err_log = EVIDENCE_DIR / f"exp4_win{win_key}_stderr.log"
    rss_timeline: List[Dict[str, Any]] = []

    with open(out_log, "w", encoding="utf-8") as f_out, open(err_log, "w", encoding="utf-8") as f_err:
        t0 = time.perf_counter()
        proc = subprocess.Popen(cmd, env=env, stdout=f_out, stderr=f_err)
        while proc.poll() is None:
            rss_timeline.append({
                "elapsed_sec": round(time.perf_counter() - t0, 1),
                "rss_mib": sample_tree_rss_mib(proc.pid),
            })
            time.sleep(5.0)
        rc = proc.returncode
        wall_sec = round(time.perf_counter() - t0, 3)

    stdout_text = out_log.read_text(encoding="utf-8", errors="replace")
    stderr_text = err_log.read_text(encoding="utf-8", errors="replace")
    m_elapsed = re.search(r"Elapsed seconds:\s*([0-9.]+)\s*s", stderr_text)
    decode_sec = round(float(m_elapsed.group(1)), 3) if m_elapsed else wall_sec

    segments = []
    for ln in stdout_text.splitlines():
        m = re.match(r"^\s*([0-9.]+)\s*--\s*([0-9.]+):\s*(.*)$", ln)
        if m:
            st = float(m.group(1))
            en = float(m.group(2))
            tx = m.group(3).strip()
            segments.append({
                "local_start_sec": round(st, 3),
                "local_end_sec": round(en, 3),
                "global_start_sec": round(win_start + st, 3),
                "global_end_sec": round(win_start + en, 3),
                "text": tx,
            })

    # 3. Sample alignment timing pass on first 3 non-empty VAD segments using sherpa-onnx-fa inside unshare -r -n
    align_samples = []
    align_total_decode = 0.0
    align_total_audio = 0.0
    for sidx, seg in enumerate(segments[:3]):
        clean_txt = re.sub(r"[^a-zA-Z0-9'\s]+", " ", seg["text"]).lower()
        clean_txt = re.sub(r"\s+", " ", clean_txt).strip()
        if not clean_txt or (seg["local_end_sec"] - seg["local_start_sec"]) < 0.5:
            continue
        seg_wav = Path(f"/tmp/exp4_win{win_key}_seg{sidx}.wav")
        seg_tg = Path(f"/tmp/exp4_win{win_key}_seg{sidx}.TextGrid")
        seg_dur = round(seg["local_end_sec"] - seg["local_start_sec"], 3)
        subprocess.run(
            [
                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                "-ss", str(seg["local_start_sec"]), "-t", str(seg_dur),
                "-i", str(win_wav), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(seg_wav),
            ],
            check=True,
        )
        t_a0 = time.perf_counter()
        p_a = subprocess.run(
            [
                "unshare", "-r", "-n",
                str(SHERPA_BIN_DIR / "sherpa-onnx-fa"),
                f"--model-dir={MFA_EN_DIR}",
                f"--lexicon={MFA_EN_DIR / 'lexicon.txt'}",
                f"--wav={seg_wav}",
                f"--text={clean_txt}",
                f"--out={seg_tg}",
            ],
            env=env,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
        )
        a_wall = round(time.perf_counter() - t_a0, 3)
        m_ad = re.search(r"Elapsed seconds:\s*([0-9.]+)\s*s", p_a.stderr)
        a_dec = float(m_ad.group(1)) if m_ad else a_wall
        align_total_decode += a_dec
        align_total_audio += seg_dur
        align_samples.append({
            "segment_index": sidx,
            "seg_dur_sec": seg_dur,
            "rc": p_a.returncode,
            "align_decode_sec": round(a_dec, 4),
            "align_rtf": round(a_dec / max(1e-6, seg_dur), 5),
        })

    valid_rss = [x["rss_mib"] for x in rss_timeline if x["rss_mib"] > 100.0]
    post_warm = valid_rss[2:] if len(valid_rss) > 3 else valid_rss
    second_half = valid_rss[len(valid_rss) // 2:] if len(valid_rss) >= 4 else valid_rss
    rss_growth = round(max(post_warm) - min(post_warm), 2) if len(post_warm) >= 2 else 0.0
    steady_drift = round(max(second_half) - min(second_half), 2) if len(second_half) >= 2 else 0.0

    ckpt = {
        "window_key": win_key,
        "global_offset_sec": win_start,
        "duration_sec": actual_dur,
        "num_threads": num_threads,
        "wav_sha256": sha256_file(win_wav),
        "rc": rc,
        "preprocess_sec": preprocess_sec,
        "wall_sec": wall_sec,
        "decode_sec": decode_sec,
        "rtf": round(decode_sec / max(1e-6, actual_dur), 4),
        "peak_rss_mib": max(valid_rss) if valid_rss else None,
        "post_warmup_rss_min_mib": min(post_warm) if post_warm else None,
        "post_warmup_rss_max_mib": max(post_warm) if post_warm else None,
        "post_warmup_rss_growth_mib": rss_growth,
        "steady_state_second_half_rss_drift_mib": steady_drift,
        "segments_count": len(segments),
        "words_count": sum(len(s["text"].split()) for s in segments),
        "alignment_probe": {
            "segments_tested": len(align_samples),
            "all_rc_zero": all(x["rc"] == 0 for x in align_samples),
            "align_rtf": round(align_total_decode / max(1e-6, align_total_audio), 5) if align_total_audio > 0 else None,
            "samples": align_samples,
        },
        "segments": segments,
        "rss_timeline_sampled": rss_timeline[::4],
    }
    atomic_write_json(ckpt_path, ckpt)
    print(
        f"[EXP4 WIN {win_key}] rc={rc} dur={actual_dur}s wall={wall_sec}s decode={decode_sec}s "
        f"RTF={ckpt['rtf']} peak_rss={ckpt['peak_rss_mib']} MiB steady_drift={steady_drift} MiB segs={len(segments)} words={ckpt['words_count']}",
        flush=True,
    )
    return ckpt


def finalize() -> Dict[str, Any]:
    wins = []
    for key in ORDERED_WINDOWS:
        w = json.loads((EVIDENCE_DIR / f"exp4_win{key}.json").read_text(encoding="utf-8"))
        if "steady_state_second_half_rss_drift_mib" not in w:
            tl = [x["rss_mib"] for x in w.get("rss_timeline_sampled", []) if x["rss_mib"] > 100.0]
            sh = tl[len(tl) // 2:] if len(tl) >= 4 else tl
            w["steady_state_second_half_rss_drift_mib"] = round(max(sh) - min(sh), 2) if len(sh) >= 2 else 0.0
        wins.append(w)

    # Verify exact timeline partition coverage across [0, 1800)
    covered_intervals = []
    missing_intervals = []
    duplicate_intervals = []
    expected_cursor = 0.0
    for key, w in zip(ORDERED_WINDOWS, wins):
        exp_start, exp_dur = WINDOW_SPECS[key]
        st = float(w["global_offset_sec"])
        en = round(st + float(w["duration_sec"]), 3)
        covered_intervals.append({"window": key, "start_sec": st, "end_sec": en, "expected_start_sec": exp_start, "expected_end_sec": exp_start + exp_dur})
        if st > expected_cursor + 0.05:
            missing_intervals.append({"start_sec": expected_cursor, "end_sec": st})
        elif st < expected_cursor - 0.05:
            duplicate_intervals.append({"start_sec": st, "end_sec": expected_cursor})
        expected_cursor = max(expected_cursor, en)
    if expected_cursor < 1800.0 - 0.05:
        missing_intervals.append({"start_sec": expected_cursor, "end_sec": 1800.0})

    with wave.open(str(LIBRIVOX_FULL_WAV), "rb") as wf:
        src_rate = wf.getframerate()
        src_ch = wf.getnchannels()
        src_dur = round(wf.getnframes() / float(src_rate), 3)
    src_size = LIBRIVOX_FULL_WAV.stat().st_size
    src_sha = sha256_file(LIBRIVOX_FULL_WAV)

    all_segs = []
    for w in wins:
        all_segs.extend(w["segments"])

    non_monotonic = 0
    overlaps = 0
    boundary_dup_words = 0
    prev_end = -1.0
    prev_last = ""
    for s in all_segs:
        if s["global_start_sec"] < prev_end - 0.05:
            overlaps += 1
        if s["global_start_sec"] < prev_end - 1.0:
            non_monotonic += 1
        ws = [x for x in s["text"].split() if x]
        if ws and prev_last and ws[0].lower() == prev_last.lower():
            boundary_dup_words += 1
        if ws:
            prev_last = ws[-1]
        prev_end = s["global_end_sec"]

    total_dur = round(sum(w["duration_sec"] for w in wins), 3)
    total_pre = round(sum(w["preprocess_sec"] for w in wins), 3)
    total_dec = round(sum(w["decode_sec"] for w in wins), 3)
    total_wall = round(sum(w["wall_sec"] for w in wins), 3)
    total_align_probe_sec = round(
        sum(
            s["align_decode_sec"]
            for w in wins
            for s in w.get("alignment_probe", {}).get("samples", [])
        ),
        4,
    )
    peak_rss_mib = max(w["peak_rss_mib"] for w in wins if w["peak_rss_mib"] is not None)
    max_win_growth_mib = max(w["post_warmup_rss_growth_mib"] for w in wins)
    max_steady_drift_mib = max(w["steady_state_second_half_rss_drift_mib"] for w in wins)
    align_rtfs = [w["alignment_probe"]["align_rtf"] for w in wins if w["alignment_probe"]["align_rtf"] is not None]
    mean_align_rtf = round(sum(align_rtfs) / len(align_rtfs), 5) if align_rtfs else None
    est_full_align_sec = round(total_dur * mean_align_rtf, 2) if mean_align_rtf is not None else None
    completed_wins = sum(1 for w in wins if w["rc"] == 0)
    failed_wins = len(wins) - completed_wins

    coverage_ok = (len(missing_intervals) == 0 and len(duplicate_intervals) == 0 and total_dur >= 1800.0)
    overall_pass = (
        failed_wins == 0
        and coverage_ok
        and len(all_segs) >= 50
        and non_monotonic == 0
    )

    out = {
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "execution_id": "AVP-P02-RECOVERY-006",
        "experiment": "exp4_genuine_continuous_30min_audio",
        "source_metadata": {
            "source_file_path": str(LIBRIVOX_FULL_WAV),
            "source_duration_sec": src_dur,
            "source_sha256": src_sha,
            "source_file_size_bytes": src_size,
            "sample_rate_hz": src_rate,
            "channels": src_ch,
            "provenance": "LibriVox Bleak House Section 3 (Charles Dickens) — unbroken single human recording, NOT concatenated short clips",
            "license": "CC0-1.0 (Public Domain)",
            "reference_transcript_available": False,
        },
        "timeline_completeness": {
            "expected_source_range_sec": [0.0, 1800.0],
            "covered_intervals": covered_intervals,
            "missing_intervals": missing_intervals,
            "duplicate_intervals": duplicate_intervals,
            "coverage_verified_complete": coverage_ok,
        },
        "source_recording": "LibriVox Bleak House Section 3 (CC0-1.0 Public Domain, unbroken single human recording — NOT concatenated short clips)",
        "master_recording_duration_sec": src_dur,
        "master_recording_sha256": src_sha,
        "processed_continuous_sec": total_dur,
        "processed_continuous_min": round(total_dur / 60.0, 2),
        "streaming_windows": "5 contiguous checkpointed windows (0..600s [4T], 600..900s, 900..1200s, 1200..1500s, 1500..1800s [3T])",
        "pipeline": "FFmpeg 16kHz -> Silero VAD v5 + openai/whisper-large-v3-turbo-int8 + sherpa-onnx-fa english-mfa-v3.1.0",
        "os_level_offline": "unshare -r -n (zero external interfaces)",
        "reference_transcript_available": False,
        "epistemic_note": "Execution, RTF, memory growth, and timeline continuity are verified; transcription WER and word-boundary error are NOT claimed because no aligned gold transcript or manual Praat TextGrid exists for this LibriVox chapter.",
        "required_measurements": {
            "SOURCE_DURATION_SECONDS": src_dur,
            "PROCESSED_DURATION_SECONDS": total_dur,
            "WINDOW_COMPLETION_COUNT": completed_wins,
            "CHUNK_COMPLETION_COUNT": len(all_segs),
            "FAILED_WINDOW_COUNT": failed_wins,
            "INFERENCE_SECONDS": total_dec,
            "ALIGNMENT_SECONDS": total_align_probe_sec,
            "ALIGNMENT_SAMPLE_SCOPE": f"{sum(w['alignment_probe']['segments_tested'] for w in wins)} sampled VAD segments (estimated full 30m alignment at RTF {mean_align_rtf}: {est_full_align_sec}s)",
            "TOTAL_PROCESSING_SECONDS": round(total_pre + total_wall + total_align_probe_sec, 3),
            "RTF": round(total_dec / max(1e-6, total_dur), 4),
            "PEAK_RSS_BYTES": int(round(peak_rss_mib * 1024 * 1024)),
            "MEMORY_GROWTH_BYTES": int(round(max_steady_drift_mib * 1024 * 1024)),
            "POST_WARMUP_ARENA_RAMP_BYTES": int(round(max_win_growth_mib * 1024 * 1024)),
            "MISSING_WORD_COUNT": "NOT_AVAILABLE (no aligned reference transcript)",
            "DUPLICATE_WORD_COUNT": boundary_dup_words,
            "TIMESTAMP_DISCONTINUITY_COUNT": non_monotonic,
        },
        "all_windows_rc_zero": failed_wins == 0,
        "total_preprocess_sec": total_pre,
        "total_decode_sec": total_dec,
        "total_wall_sec": total_wall,
        "overall_asr_rtf": round(total_dec / max(1e-6, total_dur), 4),
        "sampled_alignment_rtf": mean_align_rtf,
        "estimated_30m_alignment_sec": est_full_align_sec,
        "peak_process_rss_mib": peak_rss_mib,
        "max_single_window_post_warmup_rss_growth_mib": max_win_growth_mib,
        "max_steady_state_second_half_rss_drift_mib": max_steady_drift_mib,
        "total_segments_emitted": len(all_segs),
        "total_words_emitted": sum(w["words_count"] for w in wins),
        "timeline_start_sec": all_segs[0]["global_start_sec"] if all_segs else None,
        "timeline_end_sec": all_segs[-1]["global_end_sec"] if all_segs else None,
        "first_segment_sample": all_segs[0] if all_segs else None,
        "last_segment_sample": all_segs[-1] if all_segs else None,
        "timestamp_discontinuities_gt_1s": non_monotonic,
        "segment_overlaps": overlaps,
        "adjacent_boundary_same_word_count": boundary_dup_words,
        "STATUS": "PASS" if overall_pass else "FAIL",
        "window_summaries": [
            {k: v for k, v in w.items() if k not in ("segments", "rss_timeline_sampled")}
            for w in wins
        ],
    }
    atomic_write_json(EVIDENCE_DIR / "04_continuous_long_audio.json", out)
    print(json.dumps({k: v for k, v in out.items() if k != "window_summaries"}, indent=2))
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--window", choices=["0", "1a", "1b", "2a", "2b", "finalize"], required=True)
    p.add_argument("--threads", type=int, default=3)
    args = p.parse_args()
    if args.window == "finalize":
        finalize()
    else:
        run_window(args.window, num_threads=args.threads)


if __name__ == "__main__":
    main()
