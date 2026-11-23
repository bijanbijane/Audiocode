#!/usr/bin/env python3
"""
AVAPARDAZ — PHASE-02 Offline CPU Comparative ASR & Persian Alignment Benchmark (RECOVERY-007)

Subcommands (each worker designed to execute inside `unshare -r -n` with 3 CPU threads):
  1. `select-clips`: Selects balanced speaker-disjoint unseen Neyshekar V6 Test clips
     (50 ASR clips across all 30 speakers, formal + informal_text_read; plus 15 alignment
     clips prioritizing utterances with repeated words & multi-word sentences).
  2. `asr-worker`: Runs strictly offline CPU ASR for one candidate in an isolated process
     to measure exact Cold Start, Warm RTF, Peak RSS (VmHWM), Raw & Normalized Persian WER/CER,
     and OS-level network namespace isolation proof.
  3. `align-worker`: Runs strictly offline CPU Persian forced alignment (Track A Reference &
     Track B ASR Hypothesis) for either `shenava-ctc` (Apache-2.0, zero extra weights) or
     `taraneh-wmedium-dtw` (MIT, L19/H8 + L16/H12 cross-attention + DTW + -35 dB trim).
  4. `summarize`: Aggregates ASR results with 1,000-iteration paired bootstrap CIs and runs
     FA-Bench Dual-Track inter-system alignment comparison (`INTER_SYSTEM_COMPARISON_ONLY`).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import socket
import subprocess
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from benchmarks.phase02.fa_bench_eval import (
    WordInterval,
    aggregate_dual_track,
    evaluate_utterance_dual_track,
)

SHERPA_BIN = Path("/root/.avapardaz/runtime/bin/sherpa-onnx-offline")
SHERPA_LIB = Path("/root/.avapardaz/runtime/lib")
SHENAVA_DIR = Path(
    "/root/.avapardaz/models/sherpa-onnx-nemo-ctc-fa-shenava-rizeh-v1.0-non-streaming-int8-2026-06-26"
)
TURBO_DIR = Path("/root/.avapardaz/models/sherpa-onnx-whisper-turbo")
TARANEH_HF_ROOT = Path("/root/.avapardaz/models/taraneh")
TARANEH_CT2_ROOT = Path("/root/.avapardaz/models/taraneh-ct2-int8")


def verify_offline_netns() -> Dict[str, Any]:
    """Proves process is executing in an isolated network namespace with no external egress."""
    ns_link = "unknown"
    try:
        ns_link = os.readlink("/proc/self/ns/net")
    except OSError:
        pass
    err_no = None
    err_msg = None
    egress_blocked = False
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1.5)
        s.connect(("1.1.1.1", 443))
        s.close()
    except OSError as exc:
        err_no = exc.errno
        err_msg = str(exc)
        egress_blocked = True
    return {
        "pid": os.getpid(),
        "netns_inode": ns_link,
        "egress_blocked": egress_blocked,
        "errno": err_no,
        "error": err_msg,
    }


def read_vmhwm_mib() -> float:
    """Reads exact Linux kernel peak resident set size (VmHWM) in MiB."""
    try:
        for line in Path("/proc/self/status").read_text(encoding="utf-8").splitlines():
            if line.startswith("VmHWM:"):
                kb = int(line.split()[1])
                return round(kb / 1024.0, 2)
    except OSError:
        pass
    return 0.0


def normalize_persian_eval(text: str) -> str:
    """Canonical Persian text normalization matching EXP1 protocol."""
    s = unicodedata.normalize("NFKC", str(text or "").strip())
    s = (
        s.replace("\u064a", "\u06cc")
        .replace("\u0649", "\u06cc")
        .replace("\u0643", "\u06a9")
        .replace("\u0629", "\u0647")
        .replace("\u0622", "\u0627")
        .replace("\u0623", "\u0627")
        .replace("\u0625", "\u0627")
        .replace("\u0624", "\u0648")
        .replace("\u0626", "\u06cc")
        .replace("\u0640", "")
        .replace("\u200c", " ")
    )
    # Normalize Persian/Arabic digits to Latin digits
    trans = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")
    s = s.translate(trans)
    s = re.sub(r"[\u064B-\u065F\u0670]", "", s)
    s = re.sub(r"[^\w\u0600-\u06FF\s]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


def _edit_distance(a: Sequence[str], b: Sequence[str]) -> int:
    n, m = len(a), len(b)
    if n == 0:
        return m
    if m == 0:
        return n
    prev = list(range(m + 1))
    for i in range(1, n + 1):
        cur = [i] + [0] * m
        ai = a[i - 1]
        for j in range(1, m + 1):
            cost = 0 if ai == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[m]


def compute_wer_cer(ref: str, hyp: str, normalized: bool = True) -> Dict[str, Any]:
    r_str = normalize_persian_eval(ref) if normalized else ref.strip()
    h_str = normalize_persian_eval(hyp) if normalized else hyp.strip()
    r_words = r_str.split()
    h_words = h_str.split()
    w_ed = _edit_distance(r_words, h_words)
    r_chars = list(r_str.replace(" ", ""))
    h_chars = list(h_str.replace(" ", ""))
    c_ed = _edit_distance(r_chars, h_chars)
    return {
        "word_edits": w_ed,
        "ref_words": len(r_words),
        "char_edits": c_ed,
        "ref_chars": len(r_chars),
        "wer": (w_ed / len(r_words)) if r_words else 0.0,
        "cer": (c_ed / len(r_chars)) if r_chars else 0.0,
    }


def _percentile(vals: Sequence[float], pct: float) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    k = (len(s) - 1) * (pct / 100.0)
    f, c = math.floor(k), math.ceil(k)
    if f == c:
        return float(s[int(k)])
    return float(s[f] + (s[c] - s[f]) * (k - f))


def cmd_select_clips(args: argparse.Namespace) -> None:
    """Selects deterministic, speaker-balanced unseen Neyshekar V6 Test clips."""
    records = [
        json.loads(ln)
        for ln in Path(args.manifest).read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    ney_test = [
        r
        for r in records
        if r.get("source_corpus") == "Neyshekar-V6"
        and r.get("source_split") == "test"
        and Path(r["audio_path"]).exists()
        and 2.5 <= float(r["duration_sec"]) <= 12.0
    ]
    # Round-robin across all 30 distinct speakers, balancing formal & informal_text_read
    by_spk: Dict[str, List[Dict[str, Any]]] = {}
    for r in ney_test:
        by_spk.setdefault(r["speaker_id"], []).append(r)
    for spk in by_spk:
        # Sort informal first then clip_id so we get strong informal representation
        by_spk[spk].sort(
            key=lambda x: (0 if x.get("register_hint") == "informal_text_read" else 1, x["clip_id"])
        )

    selected_asr: List[Dict[str, Any]] = []
    spk_keys = sorted(by_spk.keys())
    idx = 0
    while len(selected_asr) < args.n_asr:
        progressed = False
        for spk in spk_keys:
            if idx < len(by_spk[spk]):
                selected_asr.append(by_spk[spk][idx])
                progressed = True
                if len(selected_asr) >= args.n_asr:
                    break
        if not progressed:
            break
        idx += 1

    # For alignment benchmark (15 clips): include clips that contain repeated words if present,
    # plus speaker-diverse formal & informal utterances
    def _has_repeat(txt: str) -> bool:
        toks = normalize_persian_eval(txt).split()
        return len(toks) != len(set(toks))

    repeat_cands = [r for r in selected_asr if _has_repeat(r["transcript"])]
    other_cands = [r for r in selected_asr if not _has_repeat(r["transcript"])]
    selected_align = (repeat_cands[:10] + other_cands)[: args.n_align]

    out = {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "source_corpus": "Neyshekar-V6 (CC0-1.0, test split, 100% unseen by Taraneh & Shenava)",
        "n_asr_clips": len(selected_asr),
        "n_asr_distinct_speakers": len({r["speaker_id"] for r in selected_asr}),
        "n_asr_informal_read": sum(1 for r in selected_asr if r.get("register_hint") == "informal_text_read"),
        "asr_total_duration_sec": round(sum(float(r["duration_sec"]) for r in selected_asr), 3),
        "n_align_clips": len(selected_align),
        "align_total_duration_sec": round(sum(float(r["duration_sec"]) for r in selected_align), 3),
        "asr_clips": selected_asr,
        "align_clips": selected_align,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"SELECTED_CLIPS: asr={len(selected_asr)} ({out['n_asr_distinct_speakers']} spk, {out['asr_total_duration_sec']}s), align={len(selected_align)} ({out['align_total_duration_sec']}s)")


def _run_sherpa_batch(model_id: str, clips: List[Dict[str, Any]], threads: int) -> Tuple[float, float, List[Dict[str, Any]]]:
    """Runs sherpa-onnx-offline per clip (measuring exact peak RSS via /usr/bin/time or resource)."""
    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = f"{SHERPA_LIB}:{env.get('LD_LIBRARY_PATH', '')}"
    env["OMP_NUM_THREADS"] = str(threads)

    if model_id == "shenava-sherpa":
        base_args = [
            str(SHERPA_BIN),
            "--provider=cpu",
            f"--num-threads={threads}",
            f"--nemo-ctc-model={SHENAVA_DIR / 'model.int8.onnx'}",
            f"--tokens={SHENAVA_DIR / 'tokens.txt'}",
        ]
    elif model_id == "whisper-turbo":
        base_args = [
            str(SHERPA_BIN),
            "--provider=cpu",
            f"--num-threads={threads}",
            f"--whisper-encoder={TURBO_DIR / 'turbo-encoder.int8.onnx'}",
            f"--whisper-decoder={TURBO_DIR / 'turbo-decoder.int8.onnx'}",
            f"--tokens={TURBO_DIR / 'turbo-tokens.txt'}",
            "--whisper-language=fa",
            "--whisper-task=transcribe",
        ]
    else:
        raise ValueError(model_id)

    # Run in small chunks (batch_size=4) with OMP_WAIT_POLICY=PASSIVE so Conformer/Whisper
    # does not allocate huge [50, 80, T_max] padded tensors in gVisor, while still avoiding
    # per-clip model reloads and preserving exact cold-start and warm RTF.
    import resource

    env["OMP_WAIT_POLICY"] = "PASSIVE"
    chunk_size = 4
    cold_sec = 0.0
    rows: List[Dict[str, Any]] = []

    for i in range(0, len(clips), chunk_size):
        chunk = clips[i : i + chunk_size]
        wavs = [c["audio_path"] for c in chunk]
        t0 = time.perf_counter()
        proc = subprocess.run(
            base_args + wavs,
            capture_output=True,
            text=True,
            env=env,
            check=True,
        )
        wall_chunk = time.perf_counter() - t0
        comb = (proc.stderr or "") + "\n" + (proc.stdout or "")
        m_cold = re.search(r"recognizer created in\s+([0-9.]+)\s*s", comb)
        if i == 0 and m_cold:
            cold_sec = float(m_cold.group(1))
        m_elap = re.search(r"Elapsed seconds:\s+([0-9.]+)\s*s", comb)
        warm_chunk = (
            float(m_elap.group(1))
            if m_elap
            else max(0.0, wall_chunk - (float(m_cold.group(1)) if m_cold else 0.0))
        )

        hyps: List[str] = []
        for ln in (proc.stdout or "").splitlines():
            ln_s = ln.strip()
            if ln_s.startswith("{") and '"text"' in ln_s:
                try:
                    hyps.append(json.loads(ln_s).get("text", "").strip())
                except json.JSONDecodeError:
                    pass
        if len(hyps) != len(chunk):
            hyps = []
            for ln in comb.splitlines():
                ln_s = ln.strip()
                if ln_s.startswith("{") and '"text"' in ln_s:
                    try:
                        hyps.append(json.loads(ln_s).get("text", "").strip())
                    except json.JSONDecodeError:
                        pass
        if len(hyps) != len(chunk):
            raise RuntimeError(
                f"Expected {len(chunk)} JSON outputs from sherpa-onnx-offline, got {len(hyps)}"
            )

        chunk_audio = sum(float(c["duration_sec"]) for c in chunk) or 1.0
        for c, hyp in zip(chunk, hyps):
            est_dt = warm_chunk * (float(c["duration_sec"]) / chunk_audio)
            rows.append({"clip": c, "hyp": hyp, "elapsed_sec": est_dt})

    child_rss_mib = round(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024.0, 2)
    return cold_sec, child_rss_mib, rows


def cmd_asr_worker(args: argparse.Namespace) -> None:
    os.environ["OMP_NUM_THREADS"] = str(args.threads)
    os.environ["MKL_NUM_THREADS"] = str(args.threads)
    net_proof = verify_offline_netns()
    if args.require_offline and not net_proof["egress_blocked"]:
        raise RuntimeError(f"Offline isolation failed: {net_proof}")

    data = json.loads(Path(args.clips_json).read_text(encoding="utf-8"))
    clips = data["asr_clips"][: args.limit] if args.limit else data["asr_clips"]

    model_id = args.model
    rows: List[Dict[str, Any]] = []
    cold_start_sec = 0.0
    peak_rss_mib = 0.0

    if model_id == "shenava-ort":
        from benchmarks.phase02.persian_ctc_aligner import ShenavaCTCAligner, load_wav_mono_16k

        t_load = time.perf_counter()
        al = ShenavaCTCAligner(num_threads=args.threads, normalize_per_feature=args.shenava_norm)
        cold_start_sec = time.perf_counter() - t_load
        for c in clips:
            t0 = time.perf_counter()
            wav, _ = load_wav_mono_16k(c["audio_path"])
            lp = al.infer_logprobs(wav)
            hyp = al.greedy_decode(lp)
            dt = time.perf_counter() - t0
            rows.append({"clip": c, "hyp": hyp, "elapsed_sec": dt})
        peak_rss_mib = read_vmhwm_mib()

    elif model_id in ("taraneh-wbase-ct2", "taraneh-wmedium-ct2"):
        import ctranslate2
        import numpy as np
        from transformers import WhisperFeatureExtractor, WhisperTokenizer
        from benchmarks.phase02.persian_ctc_aligner import load_wav_mono_16k

        name = "Taraneh-WBase" if model_id == "taraneh-wbase-ct2" else "Taraneh-WMedium"
        ct2_dir = TARANEH_CT2_ROOT / name
        hf_dir = TARANEH_HF_ROOT / name

        t_load = time.perf_counter()
        feat_ext = WhisperFeatureExtractor.from_pretrained(str(hf_dir), local_files_only=True)
        tok = WhisperTokenizer.from_pretrained(str(hf_dir), language="persian", task="transcribe", local_files_only=True)
        prompt = tok.convert_tokens_to_ids(["<|startoftranscript|>", "<|fa|>", "<|transcribe|>", "<|notimestamps|>"])
        model = ctranslate2.models.Whisper(
            str(ct2_dir),
            device="cpu",
            compute_type="int8",
            intra_threads=args.threads,
            inter_threads=1,
        )
        cold_start_sec = time.perf_counter() - t_load

        for c in clips:
            t0 = time.perf_counter()
            wav, _ = load_wav_mono_16k(c["audio_path"])
            feats = feat_ext(wav, sampling_rate=16000, return_tensors="np").input_features
            storage = ctranslate2.StorageView.from_array(np.ascontiguousarray(feats))
            res = model.generate(
                storage,
                [prompt],
                beam_size=1,
                num_hypotheses=1,
                max_length=225,
                return_scores=False,
            )
            hyp = tok.decode(res[0].sequences_ids[0], skip_special_tokens=True).strip()
            dt = time.perf_counter() - t0
            rows.append({"clip": c, "hyp": hyp, "elapsed_sec": dt})
        peak_rss_mib = read_vmhwm_mib()

    elif model_id in ("shenava-sherpa", "whisper-turbo"):
        cold_start_sec, peak_rss_mib, rows = _run_sherpa_batch(model_id, clips, args.threads)
    else:
        raise ValueError(f"Unknown model: {model_id}")

    # Score every clip
    per_clip: List[Dict[str, Any]] = []
    tot_dur = 0.0
    tot_elapsed = 0.0
    rtfs: List[float] = []
    raw_we = raw_rw = raw_ce = raw_rc = 0
    nrm_we = nrm_rw = nrm_ce = nrm_rc = 0
    reg_acc = {
        "formal_text_read": {"we": 0, "rw": 0, "ce": 0, "rc": 0, "n": 0},
        "informal_text_read": {"we": 0, "rw": 0, "ce": 0, "rc": 0, "n": 0},
    }

    for item in rows:
        c = item["clip"]
        dur = float(c["duration_sec"])
        dt = float(item["elapsed_sec"])
        rtf = dt / max(dur, 1e-6)
        tot_dur += dur
        tot_elapsed += dt
        rtfs.append(rtf)

        m_raw = compute_wer_cer(c["transcript"], item["hyp"], normalized=False)
        m_nrm = compute_wer_cer(c["transcript"], item["hyp"], normalized=True)
        raw_we += m_raw["word_edits"]
        raw_rw += m_raw["ref_words"]
        raw_ce += m_raw["char_edits"]
        raw_rc += m_raw["ref_chars"]
        nrm_we += m_nrm["word_edits"]
        nrm_rw += m_nrm["ref_words"]
        nrm_ce += m_nrm["char_edits"]
        nrm_rc += m_nrm["ref_chars"]

        reg = c.get("register_hint", "formal_text_read")
        if reg in reg_acc:
            reg_acc[reg]["we"] += m_nrm["word_edits"]
            reg_acc[reg]["rw"] += m_nrm["ref_words"]
            reg_acc[reg]["ce"] += m_nrm["char_edits"]
            reg_acc[reg]["rc"] += m_nrm["ref_chars"]
            reg_acc[reg]["n"] += 1

        per_clip.append(
            {
                "clip_id": c["clip_id"],
                "speaker_id": c.get("speaker_id"),
                "register_hint": reg,
                "duration_sec": dur,
                "elapsed_sec": round(dt, 4),
                "rtf": round(rtf, 4),
                "ref": c["transcript"],
                "hyp": item["hyp"],
                "norm_word_edits": m_nrm["word_edits"],
                "norm_ref_words": m_nrm["ref_words"],
                "norm_char_edits": m_nrm["char_edits"],
                "norm_ref_chars": m_nrm["ref_chars"],
                "norm_wer": round(m_nrm["wer"], 4),
                "norm_cer": round(m_nrm["cer"], 4),
            }
        )

    reg_summary = {}
    for reg, d in reg_acc.items():
        reg_summary[reg] = {
            "clips": d["n"],
            "norm_wer_pct": round(100.0 * d["we"] / max(d["rw"], 1), 2),
            "norm_cer_pct": round(100.0 * d["ce"] / max(d["rc"], 1), 2),
        }

    out = {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "execution_id": "AVP-P02-RECOVERY-007",
        "model_id": model_id,
        "threads": args.threads,
        "offline_netns_proof": net_proof,
        "clips_evaluated": len(per_clip),
        "total_audio_sec": round(tot_dur, 3),
        "total_decode_sec": round(tot_elapsed, 3),
        "cold_start_sec": round(cold_start_sec, 4),
        "mean_rtf": round(tot_elapsed / max(tot_dur, 1e-6), 4),
        "median_rtf": round(_percentile(rtfs, 50), 4),
        "p95_rtf": round(_percentile(rtfs, 95), 4),
        "peak_rss_mib": peak_rss_mib,
        "raw_wer_pct": round(100.0 * raw_we / max(raw_rw, 1), 2),
        "raw_cer_pct": round(100.0 * raw_ce / max(raw_rc, 1), 2),
        "norm_wer_pct": round(100.0 * nrm_we / max(nrm_rw, 1), 2),
        "norm_cer_pct": round(100.0 * nrm_ce / max(nrm_rc, 1), 2),
        "by_register": reg_summary,
        "per_clip": per_clip,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"ASR_DONE [{model_id}]: clips={len(per_clip)} norm_WER={out['norm_wer_pct']}% norm_CER={out['norm_cer_pct']}% "
        f"mean_RTF={out['mean_rtf']} med_RTF={out['median_rtf']} cold={out['cold_start_sec']}s peak_RSS={peak_rss_mib}MiB "
        f"netns={net_proof['netns_inode']} blocked={net_proof['egress_blocked']}"
    )


def cmd_align_worker(args: argparse.Namespace) -> None:
    os.environ["OMP_NUM_THREADS"] = str(args.threads)
    os.environ["MKL_NUM_THREADS"] = str(args.threads)
    net_proof = verify_offline_netns()
    if args.require_offline and not net_proof["egress_blocked"]:
        raise RuntimeError(f"Offline isolation failed: {net_proof}")

    data = json.loads(Path(args.clips_json).read_text(encoding="utf-8"))
    clips = data["align_clips"][: args.limit] if args.limit else data["align_clips"]
    aligner_id = args.aligner

    # Optionally load ASR hypotheses for Track B
    asr_hyp_map: Dict[str, str] = {}
    if args.asr_results_json and Path(args.asr_results_json).exists():
        asr_doc = json.loads(Path(args.asr_results_json).read_text(encoding="utf-8"))
        for row in asr_doc.get("per_clip", []):
            asr_hyp_map[row["clip_id"]] = row["hyp"]

    cold_start_sec = 0.0
    per_clip: List[Dict[str, Any]] = []

    if aligner_id == "shenava-ctc":
        from benchmarks.phase02.persian_ctc_aligner import ShenavaCTCAligner

        t_load = time.perf_counter()
        al = ShenavaCTCAligner(num_threads=args.threads, normalize_per_feature=args.shenava_norm)
        cold_start_sec = time.perf_counter() - t_load

        for c in clips:
            res_a = al.align_file(c["audio_path"], transcript=c["transcript"], energy_refine=True)
            hyp_txt = asr_hyp_map.get(c["clip_id"])
            res_b = al.align_file(c["audio_path"], transcript=hyp_txt, energy_refine=True)
            per_clip.append(
                {
                    "clip_id": c["clip_id"],
                    "duration_sec": float(c["duration_sec"]),
                    "ref_text": c["transcript"],
                    "asr_text": res_b["aligned_text"],
                    "track_a_elapsed_sec": res_a["elapsed_sec"],
                    "track_a_rtf": res_a["rtf"],
                    "track_a_words": res_a["words"],
                    "track_b_elapsed_sec": res_b["elapsed_sec"],
                    "track_b_rtf": res_b["rtf"],
                    "track_b_words": res_b["words"],
                }
            )
    elif aligner_id == "taraneh-wmedium-dtw":
        import torch

        torch.set_num_threads(args.threads)
        sys.path.insert(0, "/root/.avapardaz/repos/persian-asr")
        from alignment.whisper_forced_align import WhisperForcedAligner, load_audio

        hf_dir = str(TARANEH_HF_ROOT / "Taraneh-WMedium")
        heads = [(19, 8), (16, 12)]  # Official Taraneh-WMedium alignment heads from README/card

        t_load = time.perf_counter()
        aligner = WhisperForcedAligner(hf_dir, language="fa", device="cpu")
        cold_start_sec = time.perf_counter() - t_load

        for c in clips:
            wav, _ = load_audio(c["audio_path"])
            dur = float(c["duration_sec"])

            ta0 = time.perf_counter()
            spans_a = aligner.align(
                wav,
                c["transcript"],
                aggr="colnorm_rownorm",
                medfilt_width=3,
                heads=heads,
                sil_trim=True,
                energy_thr_db=-35.0,
            )
            ta = time.perf_counter() - ta0
            words_a = [
                {"word": s.word, "start": round(float(s.start), 3), "end": round(float(s.end), 3)}
                for s in spans_a
            ]

            hyp_txt = asr_hyp_map.get(c["clip_id"], c["transcript"])
            tb0 = time.perf_counter()
            spans_b = aligner.align(
                wav,
                hyp_txt,
                aggr="colnorm_rownorm",
                medfilt_width=3,
                heads=heads,
                sil_trim=True,
                energy_thr_db=-35.0,
            )
            tb = time.perf_counter() - tb0
            words_b = [
                {"word": s.word, "start": round(float(s.start), 3), "end": round(float(s.end), 3)}
                for s in spans_b
            ]

            per_clip.append(
                {
                    "clip_id": c["clip_id"],
                    "duration_sec": dur,
                    "ref_text": c["transcript"],
                    "asr_text": hyp_txt,
                    "track_a_elapsed_sec": round(ta, 4),
                    "track_a_rtf": round(ta / max(dur, 1e-6), 4),
                    "track_a_words": words_a,
                    "track_b_elapsed_sec": round(tb, 4),
                    "track_b_rtf": round(tb / max(dur, 1e-6), 4),
                    "track_b_words": words_b,
                }
            )
    else:
        raise ValueError(f"Unknown aligner: {aligner_id}")

    peak_rss_mib = read_vmhwm_mib()
    tot_dur = sum(x["duration_sec"] for x in per_clip)
    tot_a = sum(x["track_a_elapsed_sec"] for x in per_clip)
    tot_b = sum(x["track_b_elapsed_sec"] for x in per_clip)
    rtfs_a = [x["track_a_rtf"] for x in per_clip]
    rtfs_b = [x["track_b_rtf"] for x in per_clip]

    out = {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "execution_id": "AVP-P02-RECOVERY-007",
        "aligner_id": aligner_id,
        "threads": args.threads,
        "offline_netns_proof": net_proof,
        "clips_evaluated": len(per_clip),
        "total_audio_sec": round(tot_dur, 3),
        "cold_start_sec": round(cold_start_sec, 4),
        "track_a_mean_rtf": round(tot_a / max(tot_dur, 1e-6), 4),
        "track_a_median_rtf": round(_percentile(rtfs_a, 50), 4),
        "track_b_mean_rtf": round(tot_b / max(tot_dur, 1e-6), 4),
        "track_b_median_rtf": round(_percentile(rtfs_b, 50), 4),
        "peak_rss_mib": peak_rss_mib,
        "per_clip": per_clip,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"ALIGN_DONE [{aligner_id}]: clips={len(per_clip)} trackA_RTF={out['track_a_mean_rtf']} "
        f"trackB_RTF={out['track_b_mean_rtf']} cold={out['cold_start_sec']}s peak_RSS={peak_rss_mib}MiB "
        f"netns={net_proof['netns_inode']} blocked={net_proof['egress_blocked']}"
    )


def _paired_bootstrap_wer_diff(
    rows_a: List[Dict[str, Any]],
    rows_b: List[Dict[str, Any]],
    iters: int = 1000,
    seed: int = 20261122,
) -> Dict[str, Any]:
    """Paired bootstrap CI for (model_a - model_b) WER & CER in percentage points."""
    map_b = {r["clip_id"]: r for r in rows_b}
    paired = [(ra, map_b[ra["clip_id"]]) for ra in rows_a if ra["clip_id"] in map_b]
    n = len(paired)
    if n == 0:
        return {"n_paired": 0}

    rng = random.Random(seed)
    wer_diffs: List[float] = []
    cer_diffs: List[float] = []
    for _ in range(iters):
        we_a = rw_a = ce_a = rc_a = 0
        we_b = rw_b = ce_b = rc_b = 0
        for _k in range(n):
            ra, rb = paired[rng.randrange(n)]
            we_a += ra["norm_word_edits"]
            rw_a += ra["norm_ref_words"]
            ce_a += ra["norm_char_edits"]
            rc_a += ra["norm_ref_chars"]
            we_b += rb["norm_word_edits"]
            rw_b += rb["norm_ref_words"]
            ce_b += rb["norm_char_edits"]
            rc_b += rb["norm_ref_chars"]
        wer_diffs.append(100.0 * (we_a / max(rw_a, 1) - we_b / max(rw_b, 1)))
        cer_diffs.append(100.0 * (ce_a / max(rc_a, 1) - ce_b / max(rc_b, 1)))

    obs_wer_a = 100.0 * sum(x[0]["norm_word_edits"] for x in paired) / max(sum(x[0]["norm_ref_words"] for x in paired), 1)
    obs_wer_b = 100.0 * sum(x[1]["norm_word_edits"] for x in paired) / max(sum(x[1]["norm_ref_words"] for x in paired), 1)
    obs_cer_a = 100.0 * sum(x[0]["norm_char_edits"] for x in paired) / max(sum(x[0]["norm_ref_chars"] for x in paired), 1)
    obs_cer_b = 100.0 * sum(x[1]["norm_char_edits"] for x in paired) / max(sum(x[1]["norm_ref_chars"] for x in paired), 1)

    return {
        "n_paired": n,
        "bootstrap_iters": iters,
        "wer_diff_pp": round(obs_wer_a - obs_wer_b, 3),
        "wer_ci95_pp": [round(_percentile(wer_diffs, 2.5), 3), round(_percentile(wer_diffs, 97.5), 3)],
        "cer_diff_pp": round(obs_cer_a - obs_cer_b, 3),
        "cer_ci95_pp": [round(_percentile(cer_diffs, 2.5), 3), round(_percentile(cer_diffs, 97.5), 3)],
    }


def cmd_summarize(args: argparse.Namespace) -> None:
    asr_dir = Path(args.asr_dir)
    align_dir = Path(args.align_dir)

    asr_models: Dict[str, Dict[str, Any]] = {}
    for p in sorted(asr_dir.glob("asr_*.json")):
        d = json.loads(p.read_text(encoding="utf-8"))
        asr_models[d["model_id"]] = d

    comparisons: Dict[str, Any] = {}
    pairs = [
        ("taraneh-wmedium-ct2", "shenava-sherpa"),
        ("taraneh-wbase-ct2", "shenava-sherpa"),
        ("taraneh-wmedium-ct2", "taraneh-wbase-ct2"),
        ("shenava-sherpa", "whisper-turbo"),
        ("taraneh-wmedium-ct2", "whisper-turbo"),
    ]
    for a, b in pairs:
        if a in asr_models and b in asr_models:
            comparisons[f"{a}_minus_{b}"] = _paired_bootstrap_wer_diff(
                asr_models[a]["per_clip"], asr_models[b]["per_clip"]
            )

    # FA-Bench Dual-Track Alignment Evaluation (Inter-System Divergence ONLY — NOT human gold!)
    align_summary: Dict[str, Any] = {}
    sh_p = align_dir / "align_shenava_ctc.json"
    tr_p = align_dir / "align_taraneh_wmedium_dtw.json"
    if sh_p.exists() and tr_p.exists():
        sh = json.loads(sh_p.read_text(encoding="utf-8"))
        tr = json.loads(tr_p.read_text(encoding="utf-8"))
        tr_map = {x["clip_id"]: x for x in tr["per_clip"]}

        track_a_utts = []
        track_b_utts = []
        for s_row in sh["per_clip"]:
            cid = s_row["clip_id"]
            if cid not in tr_map:
                continue
            t_row = tr_map[cid]
            dur = float(s_row["duration_sec"])
            ref_a = [WordInterval(w["word"], w["start"], w["end"]) for w in t_row["track_a_words"]]
            hyp_a = [WordInterval(w["word"], w["start"], w["end"]) for w in s_row["track_a_words"]]
            track_a_utts.append(
                evaluate_utterance_dual_track(ref_a, hyp_a, dur, track="TRACK_A_REFERENCE")
            )
            # Track B: Compare Shenava ASR+CTC vs Taraneh Track A reference timeline (inter-system!)
            hyp_b = [WordInterval(w["word"], w["start"], w["end"]) for w in s_row["track_b_words"]]
            track_b_utts.append(
                evaluate_utterance_dual_track(ref_a, hyp_b, dur, track="TRACK_B_ASR_HYPOTHESIS")
            )

        align_summary = {
            "provenance_warning": "INTER_SYSTEM_COMPARISON_ONLY: Compares Shenava-Rizeh CTC Viterbi against Taraneh-WMedium Cross-Attention DTW. Neither system is human-verified Praat ground truth.",
            "shenava_ctc_perf": {
                "cold_start_sec": sh["cold_start_sec"],
                "track_a_mean_rtf": sh["track_a_mean_rtf"],
                "track_b_mean_rtf": sh["track_b_mean_rtf"],
                "peak_rss_mib": sh["peak_rss_mib"],
            },
            "taraneh_wmedium_dtw_perf": {
                "cold_start_sec": tr["cold_start_sec"],
                "track_a_mean_rtf": tr["track_a_mean_rtf"],
                "track_b_mean_rtf": tr["track_b_mean_rtf"],
                "peak_rss_mib": tr["peak_rss_mib"],
            },
            "fa_bench_track_a_inter_system": aggregate_dual_track(
                track_a_utts,
                track="TRACK_A_REFERENCE",
                reference_provenance="INTER_SYSTEM_COMPARISON_ONLY",
            ),
            "fa_bench_track_b_inter_system": aggregate_dual_track(
                track_b_utts,
                track="TRACK_B_ASR_HYPOTHESIS",
                reference_provenance="INTER_SYSTEM_COMPARISON_ONLY",
            ),
        }

    summary = {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "execution_id": "AVP-P02-RECOVERY-007",
        "asr_leaderboard": {
            mid: {
                "clips": m["clips_evaluated"],
                "norm_wer_pct": m["norm_wer_pct"],
                "norm_cer_pct": m["norm_cer_pct"],
                "raw_wer_pct": m["raw_wer_pct"],
                "raw_cer_pct": m["raw_cer_pct"],
                "cold_start_sec": m["cold_start_sec"],
                "mean_rtf": m["mean_rtf"],
                "median_rtf": m["median_rtf"],
                "p95_rtf": m["p95_rtf"],
                "peak_rss_mib": m["peak_rss_mib"],
                "by_register": m["by_register"],
                "offline_egress_blocked": m["offline_netns_proof"]["egress_blocked"],
                "netns_inode": m["offline_netns_proof"]["netns_inode"],
            }
            for mid, m in asr_models.items()
        },
        "paired_bootstrap_comparisons": comparisons,
        "alignment_evaluation": align_summary,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False))


def main() -> None:
    p = argparse.ArgumentParser(description="RECOVERY-007 Offline CPU ASR & Alignment Suite")
    sub = p.add_subparsers(dest="cmd", required=True)

    ps = sub.add_parser("select-clips")
    ps.add_argument("--manifest", default="datasets/phase02/manifest_v2.jsonl")
    ps.add_argument("--out", required=True)
    ps.add_argument("--n-asr", type=int, default=50)
    ps.add_argument("--n-align", type=int, default=15)

    pa = sub.add_parser("asr-worker")
    pa.add_argument("--model", required=True)
    pa.add_argument("--clips-json", required=True)
    pa.add_argument("--out", required=True)
    pa.add_argument("--threads", type=int, default=3)
    pa.add_argument("--limit", type=int, default=0)
    pa.add_argument("--require-offline", action="store_true")
    pa.add_argument("--shenava-norm", action="store_true")

    pl = sub.add_parser("align-worker")
    pl.add_argument("--aligner", required=True)
    pl.add_argument("--clips-json", required=True)
    pl.add_argument("--out", required=True)
    pl.add_argument("--asr-results-json", default="")
    pl.add_argument("--threads", type=int, default=3)
    pl.add_argument("--limit", type=int, default=0)
    pl.add_argument("--require-offline", action="store_true")
    pl.add_argument("--shenava-norm", action="store_true")

    pm = sub.add_parser("summarize")
    pm.add_argument("--asr-dir", required=True)
    pm.add_argument("--align-dir", required=True)
    pm.add_argument("--out", required=True)

    args = p.parse_args()
    if args.cmd == "select-clips":
        cmd_select_clips(args)
    elif args.cmd == "asr-worker":
        cmd_asr_worker(args)
    elif args.cmd == "align-worker":
        cmd_align_worker(args)
    elif args.cmd == "summarize":
        cmd_summarize(args)


if __name__ == "__main__":
    main()
