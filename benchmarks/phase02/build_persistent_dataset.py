#!/usr/bin/env python3
"""
AVAPARDAZ — PHASE-02 Persistent Legally Verified Evaluation Dataset Builder (RECOVERY-003)

Builds a persistent, SHA-256-verified, deduplicated evaluation archive outside /tmp
(at /root/.avapardaz/datasets/avp-p02-v1/) and writes traceable metadata manifests into
datasets/phase02/ (never committing large binary audio files into Git).

Sources (100% first-party, legally verified):
1. google/fleurs (fa_ir dev split, CC-BY-4.0) — test split & PESTE Benchmark strictly untouched.
2. google/fleurs (en_us dev split, CC-BY-4.0) — test split strictly untouched.
3. LibriVox Bleak House Section 3 (en, CC0-1.0 Public Domain, 59.39 min continuous single recording).
"""

from __future__ import annotations

import array
import csv
import hashlib
import json
import os
import subprocess
import tarfile
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple


REPO_ROOT = Path(__file__).resolve().parents[2]
DATASETS_META_DIR = REPO_ROOT / "datasets" / "phase02"
ARCHIVE_ROOT = Path("/root/.avapardaz/datasets/avp-p02-v1")
RAW_FLEURS_ROOT = Path("/root/.avapardaz/datasets/fleurs")
LIBRIVOX_WAV = Path("/root/.avapardaz/datasets/librivox/bleak_house_03_16k.wav")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def wav_info_and_fingerprint(path: Path) -> Tuple[float, str]:
    """Computes exact duration (sec) and 32-band coarse RMS energy acoustic fingerprint for near-duplicate checks."""
    with wave.open(str(path), "rb") as wf:
        sr = wf.getframerate()
        nframes = wf.getnframes()
        dur = nframes / float(sr) if sr > 0 else 0.0
        raw = wf.readframes(min(nframes, sr * 20))
    samples = array.array("h")
    samples.frombytes(raw)
    if not samples:
        return round(dur, 3), "empty"
    step = max(1, len(samples) // 32)
    rms_vals = []
    for i in range(0, len(samples), step):
        seg = samples[i : i + step]
        if not seg:
            continue
        rms_vals.append((sum(x * x for x in seg) / len(seg)) ** 0.5)
        if len(rms_vals) == 32:
            break
    peak = max(rms_vals) if rms_vals else 1.0
    if peak < 1e-6:
        peak = 1.0
    bins = [min(9, int((v / peak) * 9.99)) for v in rms_vals]
    fp = f"{dur:.2f}:" + "".join(str(b) for b in bins)
    return round(dur, 3), hashlib.md5(fp.encode("ascii")).hexdigest()[:16]


def parse_all_fleurs_tsv(tsv_path: Path) -> List[Dict[str, str]]:
    rows: List[Dict[str, str]] = []
    with open(tsv_path, "r", encoding="utf-8") as fh:
        reader = csv.reader(fh, delimiter="\t")
        for row in reader:
            if len(row) < 6:
                continue
            uid, fname, raw_tr, norm_tr, _, num_samples_str = row[:6]
            try:
                ns = int(num_samples_str)
            except ValueError:
                continue
            text = (raw_tr or norm_tr or "").strip()
            if not text or ns <= 0:
                continue
            rows.append({
                "fleurs_id": uid.strip(),
                "filename": fname.strip(),
                "raw_transcription": raw_tr.strip(),
                "fleurs_transcription": norm_tr.strip(),
                "num_samples": str(ns),
                "gender": row[6].strip() if len(row) > 6 else "unknown",
            })
    return rows


def extract_tar_all(tar_path: Path, dest_dir: Path) -> Dict[str, Path]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    found: Dict[str, Path] = {}
    with tarfile.open(tar_path, "r:gz") as tf:
        for m in tf:
            if not m.isfile():
                continue
            base = os.path.basename(m.name)
            out_path = dest_dir / base
            if not out_path.exists():
                src = tf.extractfile(m)
                if src is not None:
                    with open(out_path, "wb") as out_f:
                        out_f.write(src.read())
            found[base] = out_path
    return found


def to_canonical_wav(src: Path, dst: Path) -> None:
    if dst.exists() and dst.stat().st_size > 44:
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", str(dst)],
        check=True,
    )


def main() -> None:
    DATASETS_META_DIR.mkdir(parents=True, exist_ok=True)
    ARCHIVE_ROOT.mkdir(parents=True, exist_ok=True)

    manifest_entries: List[Dict[str, Any]] = []
    seen_sha256 = set()
    seen_fp = set()
    duplicate_audio_skipped = 0
    near_duplicate_flagged = 0

    for lang, subdir in (("fa", "fa_ir"), ("en", "en_us")):
        tsv = RAW_FLEURS_ROOT / subdir / "dev.tsv"
        tgz = RAW_FLEURS_ROOT / subdir / "dev.tar.gz"
        rows = parse_all_fleurs_tsv(tsv)
        extracted = extract_tar_all(tgz, RAW_FLEURS_ROOT / subdir / "extracted")
        out_dir = ARCHIVE_ROOT / f"fleurs_{lang}_dev"
        out_dir.mkdir(parents=True, exist_ok=True)

        # Deduplicate by filename (multiple speakers in FLEURS can share sentence id, so filename is recording ID)
        seen_files = set()
        for idx, row in enumerate(rows, start=1):
            fname = row["filename"]
            if fname in seen_files:
                continue
            seen_files.add(fname)
            src = extracted.get(fname)
            if not src or not src.exists():
                continue
            sid = f"fleurs-{lang}-dev-{idx:04d}"
            dst = out_dir / f"{sid}.wav"
            to_canonical_wav(src, dst)
            h = sha256_file(dst)
            if h in seen_sha256:
                duplicate_audio_skipped += 1
                continue
            seen_sha256.add(h)
            dur, fp = wav_info_and_fingerprint(dst)
            is_near_dup = fp in seen_fp
            if is_near_dup:
                near_duplicate_flagged += 1
            seen_fp.add(fp)

            # Deterministic partition: first 100 clips -> dev, remaining -> heldout_eval (disjoint recording IDs)
            split_role = "dev" if idx <= 100 else "heldout_eval"
            manifest_entries.append({
                "sample_id": sid,
                "dataset_version": "avp-p02-v1",
                "split": split_role,
                "source_dataset": f"google/fleurs ({subdir}, dev split)",
                "source_recording_id": fname,
                "source_utterance_id": row["fleurs_id"],
                "speaker_id": f"fleurs_{lang}_rec_{os.path.splitext(fname)[0]}",
                "gender": row["gender"],
                "language": lang,
                "speech_style": "read_formal",
                "audio_path": str(dst),
                "audio_sha256": h,
                "acoustic_fingerprint": fp,
                "near_duplicate_flag": is_near_dup,
                "duration_sec": dur,
                "sample_rate": 16000,
                "channels": 1,
                "transcript_reference": row["raw_transcription"],
                "annotation_state": "source_transcript_only",
                "manual_word_timestamps": False,
                "license_spdx": "CC-BY-4.0",
                "license_evidence": "Google FLEURS official release (Conneau et al., 2022, CC-BY-4.0)",
            })

    # Add genuine 59.39-min LibriVox Continuous Long-Audio Recording (CC0-1.0 Public Domain)
    if LIBRIVOX_WAV.exists():
        h = sha256_file(LIBRIVOX_WAV)
        dur, fp = wav_info_and_fingerprint(LIBRIVOX_WAV)
        manifest_entries.append({
            "sample_id": "librivox-en-bleakhouse-ch03-continuous",
            "dataset_version": "avp-p02-v1",
            "split": "long_audio_eval",
            "source_dataset": "LibriVox / Internet Archive (Bleak House, Section 3)",
            "source_recording_id": "bleak_house_03_dickens_64kb.mp3",
            "source_utterance_id": "bleak_house_cl_librivox_sec03",
            "speaker_id": "librivox_bleak_house_reader_03",
            "gender": "unknown",
            "language": "en",
            "speech_style": "continuous_long_form_narration",
            "audio_path": str(LIBRIVOX_WAV),
            "audio_sha256": h,
            "acoustic_fingerprint": fp,
            "near_duplicate_flag": False,
            "duration_sec": dur,
            "sample_rate": 16000,
            "channels": 1,
            "transcript_reference": None,
            "annotation_state": "continuous_unsegmented_audio",
            "manual_word_timestamps": False,
            "license_spdx": "CC0-1.0",
            "license_evidence": "LibriVox public domain recording (https://librivox.org/pages/public-domain/)",
        })

    manifest_path = DATASETS_META_DIR / "manifest_v1.jsonl"
    with open(manifest_path, "w", encoding="utf-8") as fh:
        for e in manifest_entries:
            fh.write(json.dumps(e, ensure_ascii=False) + "\n")

    fa_entries = [e for e in manifest_entries if e["language"] == "fa"]
    en_fleurs = [e for e in manifest_entries if e["language"] == "en" and e["split"] != "long_audio_eval"]
    long_entries = [e for e in manifest_entries if e["split"] == "long_audio_eval"]

    fa_sec = sum(e["duration_sec"] for e in fa_entries)
    en_sec = sum(e["duration_sec"] for e in en_fleurs)
    long_sec = sum(e["duration_sec"] for e in long_entries)
    total_sec = fa_sec + en_sec + long_sec

    dev_entries = [e for e in manifest_entries if e["split"] == "dev"]
    heldout_entries = [e for e in manifest_entries if e["split"] == "heldout_eval"]

    summary = {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "dataset_version": "avp-p02-v1",
        "archive_root": str(ARCHIVE_ROOT),
        "manifest_path": str(manifest_path.relative_to(REPO_ROOT)),
        "manifest_sha256": sha256_file(manifest_path),
        "counts": {
            "total_clips": len(manifest_entries),
            "fa_fleurs_dev_clips": len(fa_entries),
            "en_fleurs_dev_clips": len(en_fleurs),
            "continuous_long_audio_clips": len(long_entries),
            "dev_split_clips": len(dev_entries),
            "heldout_split_clips": len(heldout_entries),
            "exact_duplicates_skipped": duplicate_audio_skipped,
            "acoustic_near_duplicates_flagged": near_duplicate_flagged,
        },
        "durations_hours": {
            "fa_read_hours": round(fa_sec / 3600.0, 4),
            "en_read_hours": round(en_sec / 3600.0, 4),
            "en_continuous_long_hours": round(long_sec / 3600.0, 4),
            "total_verified_hours": round(total_sec / 3600.0, 4),
            "dev_split_hours": round(sum(e["duration_sec"] for e in dev_entries) / 3600.0, 4),
            "heldout_split_hours": round(sum(e["duration_sec"] for e in heldout_entries) / 3600.0, 4),
            "natural_persian_conversational_hours": 0.0,
            "natural_disfluency_hours": 0.0,
            "natural_code_switching_hours": 0.0,
            "manual_word_timestamp_hours": 0.0,
        },
        "target_shortfalls": {
            "total_6h_target_met": (total_sec / 3600.0) >= 6.0,
            "dev_2h_target_met": (sum(e["duration_sec"] for e in dev_entries) / 3600.0) >= 2.0,
            "heldout_4h_target_met": (sum(e["duration_sec"] for e in heldout_entries) / 3600.0) >= 4.0,
            "heldout_200_clips_met": len(heldout_entries) >= 200,
            "dev_100_clips_met": len(dev_entries) >= 100,
            "distinct_heldout_speakers_note": "FLEURS dev metadata provides recording IDs and gender, not verified speaker IDs; speaker count cannot be overstated as 20+ verified distinct speakers without diarization/metadata.",
            "missing_natural_conversational_fa": "BLOCKER: Legally cleared conversational Persian podcasts/interviews not available via automated open-license download (YouTube-scraped HF datasets rejected due to unclear commercial audio rights).",
            "missing_natural_disfluencies": "BLOCKER: 0.0h verified natural Persian disfluencies (target >= 0.5h).",
            "missing_natural_code_switching": "BLOCKER: 0.0h verified natural intra-sentence FA-EN code-switching (target >= 0.5h).",
            "missing_manual_word_timestamps": "BLOCKER: 0.0h human-verified Praat TextGrid annotations (target >= 1.0h).",
        },
    }
    (DATASETS_META_DIR / "dataset_summary_v1.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # Queue first 30 FA + 30 EN clips for pilot Praat manual annotation assignment
    queue = {
        "generated_utc": summary["generated_utc"],
        "status": "AWAITING_HUMAN_ANNOTATORS",
        "double_annotation_overlap_ratio": 0.20,
        "clips": [
            {
                "sample_id": e["sample_id"],
                "language": e["language"],
                "duration_sec": e["duration_sec"],
                "audio_sha256": e["audio_sha256"],
                "source_transcript_reference": e["transcript_reference"],
                "double_annotate_for_iaa": (i % 5 == 0),
                "annotation_state": "PENDING_HUMAN_PRAAT",
            }
            for i, e in enumerate(fa_entries[:30] + en_fleurs[:30])
        ],
    }
    (DATASETS_META_DIR / "annotation_assignment_queue.json").write_text(
        json.dumps(queue, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(json.dumps(summary["counts"], indent=2))
    print(json.dumps(summary["durations_hours"], indent=2))


if __name__ == "__main__":
    main()
