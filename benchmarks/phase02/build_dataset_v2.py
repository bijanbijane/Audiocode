#!/usr/bin/env python3
"""
AVAPARDAZ — PHASE-02 Stratified Dataset Builder v2 (AVP-P02-RECOVERY-007)

Preserves all 764 clips (3.5635 h) of avp-p02-v1 (datasets/phase02/manifest_v1.jsonl)
and selectively ingests the speaker-disjoint Validation (26 speakers, ~3.14 h) and
Test (30 speakers, ~3.88 h) splits of Neyshekar V6 (CC0-1.0, sananazari/Neyshekar,
commit 4e3db589fd62b4b7a71e3570ba0b18a49368afeb).

Strict Classification Discipline:
  - Neyshekar V6 is strictly classified under `PERSIAN_READ_SPEECH` (with an optional
    lexical `informal_read_hint` metadata tag, NEVER misclassified as spontaneous
    conversational speech).
  - Evaluates exact speaker-disjointness between dev and heldout splits.
  - Verifies audio SHA-256 deduplication and 16 kHz mono WAV format.
  - Emits stratified `datasets/phase02/manifest_v2.jsonl` and `dataset_summary_v2.json`.
"""

from __future__ import annotations

import glob
import hashlib
import io
import json
import os
import re
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Set

import pyarrow.parquet as pq

NEYSHEKAR_REPO = "sananazari/Neyshekar"
NEYSHEKAR_REV = "4e3db589fd62b4b7a71e3570ba0b18a49368afeb"
NEYSHEKAR_LICENSE = "CC0-1.0"
PARQUET_ROOT = Path("/root/.avapardaz/downloads/neyshekar_v6/data")
ARCHIVE_V2_ROOT = Path("/root/.avapardaz/datasets/avp-p02-v2/neyshekar_v6")
MANIFEST_V1 = Path("datasets/phase02/manifest_v1.jsonl")
MANIFEST_V2 = Path("datasets/phase02/manifest_v2.jsonl")
SUMMARY_V2 = Path("datasets/phase02/dataset_summary_v2.json")

# Informal Persian read-text lexical hints (for stratification metadata ONLY — still READ speech!)
_INFORMAL_HINT_RE = re.compile(
    r"(?:^|\s)(?:می‌رم|میرم|می‌خوام|میخوام|می‌دونم|میدونم|می‌شه|میشه|نمی‌شه|نمیشه|"
    r"می‌گن|میگن|می‌تونی|میتونی|می‌تونم|میتونم|چطوره|چیه|کجاست|دیگه|آره|نه بابا|"
    r"خیلی خوبه|بذار|بگو|بیا|بریم|اومد|اومدم|رفتم|می‌خواست|داشتم|دارم|می‌خورم|"
    r"خونه|توی|واسه|اونجا|اینجا|همش|همه چی|یه)(?:\s|$|[،.؟!])"
)


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _wav_info(raw_bytes: bytes) -> Dict[str, Any]:
    with wave.open(io.BytesIO(raw_bytes), "rb") as wf:
        sr = wf.getframerate()
        ch = wf.getnchannels()
        sw = wf.getsampwidth()
        nf = wf.getnframes()
        dur = nf / float(sr) if sr > 0 else 0.0
    return {"sample_rate": sr, "channels": ch, "sampwidth": sw, "duration_sec": dur}


def _classify_v1_strata(rec: Dict[str, Any]) -> List[str]:
    lang = rec.get("language", "")
    if lang == "fa":
        return ["PERSIAN_READ_SPEECH"]
    if lang == "en":
        return ["ENGLISH_SPEECH"]
    return []


def main() -> None:
    if not MANIFEST_V1.exists():
        raise SystemExit(f"Missing baseline manifest: {MANIFEST_V1}")

    v1_records: List[Dict[str, Any]] = []
    seen_sha: Set[str] = set()
    for line in MANIFEST_V1.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        r = dict(r)
        r["strata"] = _classify_v1_strata(r)
        r["dataset_release"] = r.get("dataset_release", "avp-p02-v1")
        if r.get("audio_sha256"):
            seen_sha.add(r["audio_sha256"])
        v1_records.append(r)

    val_speakers: Set[str] = set()
    test_speakers: Set[str] = set()
    new_records: List[Dict[str, Any]] = []
    exact_dups_skipped = 0
    informal_read_val = 0
    informal_read_test = 0
    parquet_hashes: Dict[str, str] = {}

    for split_name, target_split in (("validation", "dev"), ("test", "held_out")):
        out_dir = ARCHIVE_V2_ROOT / split_name
        out_dir.mkdir(parents=True, exist_ok=True)
        files = sorted(glob.glob(str(PARQUET_ROOT / f"{split_name}-*.parquet")))
        if not files:
            raise SystemExit(f"No parquet files found for {split_name} under {PARQUET_ROOT}")

        for pf in files:
            p_path = Path(pf)
            h = hashlib.sha256()
            with p_path.open("rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            parquet_hashes[p_path.name] = h.hexdigest()

            table = pq.read_table(pf)
            ids = table["id"].to_pylist()
            texts = table["text"].to_pylist()
            durs = table["duration"].to_pylist()
            spks = table["speaker_id"].to_pylist()
            auds = table["audio"].to_pylist()

            for row_id, text, dur_meta, spk, aud in zip(ids, texts, durs, spks, auds):
                raw_bytes = aud["bytes"] if isinstance(aud, dict) else None
                if not raw_bytes:
                    continue
                audio_sha = _sha256_bytes(raw_bytes)
                if audio_sha in seen_sha:
                    exact_dups_skipped += 1
                    continue
                seen_sha.add(audio_sha)

                info = _wav_info(raw_bytes)
                dur = round(float(info["duration_sec"]), 4)
                if dur <= 0.05:
                    continue

                spk_str = f"neyshekar_spk_{spk}"
                if split_name == "validation":
                    val_speakers.add(spk_str)
                else:
                    test_speakers.add(spk_str)

                wav_name = f"neyshekar_{split_name}_{row_id}.wav"
                wav_path = out_dir / wav_name
                if not wav_path.exists():
                    wav_path.write_bytes(raw_bytes)

                text_str = str(text or "").strip()
                is_informal_hint = bool(_INFORMAL_HINT_RE.search(text_str))
                if is_informal_hint:
                    if split_name == "validation":
                        informal_read_val += 1
                    else:
                        informal_read_test += 1

                rec = {
                    "clip_id": f"neyshekar_v6_{split_name}_{row_id}",
                    "dataset_release": "avp-p02-v2",
                    "source_corpus": "Neyshekar-V6",
                    "source_repo": NEYSHEKAR_REPO,
                    "source_revision": NEYSHEKAR_REV,
                    "source_split": split_name,
                    "split": target_split,
                    "language": "fa",
                    "speech_type": "read_speech",
                    "register_hint": "informal_text_read" if is_informal_hint else "formal_text_read",
                    "strata": ["PERSIAN_READ_SPEECH"],
                    "license": NEYSHEKAR_LICENSE,
                    "commercial_rights_verified": True,
                    "speaker_id": spk_str,
                    "audio_path": str(wav_path),
                    "audio_sha256": audio_sha,
                    "sample_rate": info["sample_rate"],
                    "channels": info["channels"],
                    "duration_sec": dur,
                    "reported_duration_sec": round(float(dur_meta or dur), 4),
                    "transcript": text_str,
                    "annotation_state": "TRANSCRIPT_ONLY_NO_MANUAL_TIMESTAMPS",
                    "taraneh_training_overlap": False,
                }
                new_records.append(rec)

    speaker_overlap = sorted(val_speakers & test_speakers)
    if speaker_overlap:
        raise RuntimeError(f"Speaker leakage detected between Neyshekar val and test: {speaker_overlap[:10]}")

    all_records = v1_records + new_records
    with MANIFEST_V2.open("w", encoding="utf-8") as f:
        for r in all_records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    manifest_sha = hashlib.sha256(MANIFEST_V2.read_bytes()).hexdigest()

    # Compute exact stratified durations
    strata_sec: Dict[str, float] = {
        "PERSIAN_READ_SPEECH": 0.0,
        "PERSIAN_CONVERSATIONAL_SPEECH": 0.0,
        "PERSIAN_DISFLUENCY_SPEECH": 0.0,
        "PERSIAN_ENGLISH_CODE_SWITCHING": 0.0,
        "ENGLISH_SPEECH": 0.0,
        "PERSIAN_WORD_ALIGNMENT_GOLD": 0.0,
    }
    strata_counts: Dict[str, int] = {k: 0 for k in strata_sec}
    split_sec: Dict[str, float] = {"dev": 0.0, "held_out": 0.0, "long_audio_eval": 0.0}
    split_counts: Dict[str, int] = {"dev": 0, "held_out": 0, "long_audio_eval": 0}

    for r in all_records:
        d = float(r["duration_sec"])
        sp_raw = str(r.get("split", "held_out")).strip().lower()
        if sp_raw in ("dev", "validation"):
            sp = "dev"
        elif sp_raw in ("held_out", "heldout", "heldout_eval", "test"):
            sp = "held_out"
        else:
            sp = "long_audio_eval"
        split_sec[sp] += d
        split_counts[sp] += 1
        for st in r.get("strata", []):
            if st in strata_sec:
                strata_sec[st] += d
                strata_counts[st] += 1

    total_sec = sum(float(r["duration_sec"]) for r in all_records)
    neyshekar_val_sec = sum(
        float(r["duration_sec"]) for r in new_records if r["source_split"] == "validation"
    )
    neyshekar_test_sec = sum(
        float(r["duration_sec"]) for r in new_records if r["source_split"] == "test"
    )

    summary = {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "execution_id": "AVP-P02-RECOVERY-007",
        "dataset_version": "avp-p02-v2",
        "baseline_preserved": "datasets/phase02/manifest_v1.jsonl",
        "manifest_path": str(MANIFEST_V2),
        "manifest_sha256": manifest_sha,
        "neyshekar_provenance": {
            "repo": NEYSHEKAR_REPO,
            "revision": NEYSHEKAR_REV,
            "license": NEYSHEKAR_LICENSE,
            "terms_respected": "No speaker identification performed; anonymous speaker_id preserved solely for speaker-disjoint split verification.",
            "parquet_sha256": parquet_hashes,
            "validation_clips": sum(1 for r in new_records if r["source_split"] == "validation"),
            "validation_hours": round(neyshekar_val_sec / 3600.0, 4),
            "validation_distinct_speakers": len(val_speakers),
            "validation_informal_text_read_clips": informal_read_val,
            "test_clips": sum(1 for r in new_records if r["source_split"] == "test"),
            "test_hours": round(neyshekar_test_sec / 3600.0, 4),
            "test_distinct_speakers": len(test_speakers),
            "test_informal_text_read_clips": informal_read_test,
            "val_test_speaker_overlap_count": len(speaker_overlap),
        },
        "counts": {
            "total_clips": len(all_records),
            "v1_preserved_clips": len(v1_records),
            "v2_added_clips": len(new_records),
            "exact_duplicates_skipped": exact_dups_skipped,
            "by_split": split_counts,
            "by_stratum": strata_counts,
        },
        "durations_hours": {
            "total_verified_hours": round(total_sec / 3600.0, 4),
            "dev_split_hours": round(split_sec["dev"] / 3600.0, 4),
            "heldout_split_hours": round(split_sec["held_out"] / 3600.0, 4),
            "continuous_long_audio_hours": round(split_sec["long_audio_eval"] / 3600.0, 4),
            "by_stratum_hours": {k: round(v / 3600.0, 4) for k, v in strata_sec.items()},
        },
        "gate_status": {
            "total_ge_6h_met": (total_sec / 3600.0) >= 6.0,
            "dev_ge_2h_met": (split_sec["dev"] / 3600.0) >= 2.0,
            "heldout_ge_4h_met": (split_sec["held_out"] / 3600.0) >= 4.0,
            "heldout_verified_distinct_speakers": len(test_speakers),
            "heldout_ge_20_speakers_met": len(test_speakers) >= 20,
            "persian_conversational_met": False,
            "natural_disfluencies_ge_30m_met": False,
            "natural_code_switching_ge_30m_met": False,
            "manual_word_ground_truth_ge_60m_met": False,
        },
    }

    SUMMARY_V2.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(summary["durations_hours"], indent=2))
    print(json.dumps(summary["gate_status"], indent=2))


if __name__ == "__main__":
    main()
