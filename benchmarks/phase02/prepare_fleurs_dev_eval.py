#!/usr/bin/env python3
"""
AVAPARDAZ — PHASE-02 Real Licensed Evaluation Set Builder (Google FLEURS CC-BY-4.0 dev split)

Strictly uses the FLEURS `dev` split (never touching `test` or PESTE Benchmark) so the
Frozen Test Set remains 100% uncontaminated.

Outputs canonical 16 kHz Mono PCM16 WAV files + SHA-256 manifest:
- 10 distinct-speaker Persian (`fa`) utterances
- 10 distinct-speaker English (`en`) utterances
- 5 bilingual language-switch (`fa-en-concat`) utterances created by concatenating real
  Persian + 350ms silence + real English utterances (explicitly labeled as concatenated
  bilingual switch, NOT synthetic TTS and NOT natural intra-sentential studio code-switching).
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import subprocess
import tarfile
import wave
from pathlib import Path
from typing import Any, Dict, List


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wf:
        return wf.getnframes() / float(wf.getframerate())


def parse_fleurs_tsv(tsv_path: Path, limit: int = 10) -> List[Dict[str, str]]:
    """
    FLEURS TSV columns (no header):
    0: id (sentence/utterance id)
    1: filename (e.g. 123456.wav)
    2: raw_transcription
    3: transcription (normalized by FLEURS)
    4: char_seq
    5: num_samples
    6: gender
    Selects up to `limit` clean medium-length utterances (4s..13s @ 16kHz -> 64k..208k samples)
    with unique utterance IDs.
    """
    selected: List[Dict[str, str]] = []
    seen_ids = set()
    with open(tsv_path, "r", encoding="utf-8") as fh:
        reader = csv.reader(fh, delimiter="\t")
        for row in reader:
            if len(row) < 6:
                continue
            uid, fname, raw_tr, norm_tr, _, num_samples_str = row[:6]
            if uid in seen_ids:
                continue
            try:
                ns = int(num_samples_str)
            except ValueError:
                continue
            dur_est = ns / 16000.0
            if dur_est < 4.0 or dur_est > 12.5:
                continue
            text = (raw_tr or norm_tr or "").strip()
            if not text:
                continue
            seen_ids.add(uid)
            selected.append({
                "fleurs_id": uid,
                "filename": fname.strip(),
                "raw_transcription": raw_tr.strip(),
                "fleurs_transcription": norm_tr.strip(),
                "gender": row[6].strip() if len(row) > 6 else "unknown",
            })
            if len(selected) >= limit:
                break
    return selected


def extract_needed_from_tar(tar_path: Path, needed_basenames: set[str], dest_dir: Path) -> Dict[str, Path]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    found: Dict[str, Path] = {}
    with tarfile.open(tar_path, "r:gz") as tf:
        for member in tf:
            if not member.isfile():
                continue
            base = os.path.basename(member.name)
            if base in needed_basenames:
                out_path = dest_dir / base
                src = tf.extractfile(member)
                if src is not None:
                    with open(out_path, "wb") as out_f:
                        out_f.write(src.read())
                    found[base] = out_path
                if len(found) == len(needed_basenames):
                    break
    return found


def convert_to_canonical_16k_wav(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(src),
            "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
            str(dst),
        ],
        check=True,
    )


def concat_bilingual_wav(fa_wav: Path, en_wav: Path, dst: Path) -> None:
    """Concatenates real FA wav + 350ms silence + real EN wav at 16 kHz Mono PCM16."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(fa_wav),
            "-f", "lavfi", "-t", "0.35", "-i", "anullsrc=r=16000:cl=mono",
            "-i", str(en_wav),
            "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
            "-map", "[out]",
            "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
            str(dst),
        ],
        check=True,
    )


def main() -> None:
    base = Path("/tmp/avp-p02-bench/audio")
    out_wav_dir = base / "canonical_16k"
    out_wav_dir.mkdir(parents=True, exist_ok=True)

    fa_rows = parse_fleurs_tsv(base / "fa_ir" / "dev.tsv", limit=10)
    en_rows = parse_fleurs_tsv(base / "en_us" / "dev.tsv", limit=10)

    fa_files = extract_needed_from_tar(
        base / "fa_ir" / "dev.tar.gz",
        {r["filename"] for r in fa_rows},
        base / "fa_ir" / "extracted",
    )
    en_files = extract_needed_from_tar(
        base / "en_us" / "dev.tar.gz",
        {r["filename"] for r in en_rows},
        base / "en_us" / "extracted",
    )

    samples: List[Dict[str, Any]] = []
    fa_canonical: List[Dict[str, Any]] = []
    en_canonical: List[Dict[str, Any]] = []

    for idx, row in enumerate(fa_rows, start=1):
        src = fa_files.get(row["filename"])
        if not src:
            continue
        sid = f"fleurs-fa-dev-{idx:02d}"
        dst = out_wav_dir / f"{sid}.wav"
        convert_to_canonical_16k_wav(src, dst)
        entry = {
            "sample_id": sid,
            "source_dataset": "google/fleurs (fa_ir, dev split)",
            "source_utterance_id": row["fleurs_id"],
            "license": "CC-BY-4.0",
            "language": "fa",
            "audio": str(dst),
            "duration_sec": round(wav_duration(dst), 3),
            "sha256": sha256_file(dst),
            "reference": row["raw_transcription"],
        }
        samples.append(entry)
        fa_canonical.append(entry)

    for idx, row in enumerate(en_rows, start=1):
        src = en_files.get(row["filename"])
        if not src:
            continue
        sid = f"fleurs-en-dev-{idx:02d}"
        dst = out_wav_dir / f"{sid}.wav"
        convert_to_canonical_16k_wav(src, dst)
        entry = {
            "sample_id": sid,
            "source_dataset": "google/fleurs (en_us, dev split)",
            "source_utterance_id": row["fleurs_id"],
            "license": "CC-BY-4.0",
            "language": "en",
            "audio": str(dst),
            "duration_sec": round(wav_duration(dst), 3),
            "sha256": sha256_file(dst),
            "reference": row["raw_transcription"],
        }
        samples.append(entry)
        en_canonical.append(entry)

    # 5 Bilingual language-switch pairs (real FA + 350ms silence + real EN)
    for idx in range(min(5, len(fa_canonical), len(en_canonical))):
        fa_e = fa_canonical[idx]
        en_e = en_canonical[idx]
        sid = f"fleurs-bi-switch-{idx + 1:02d}"
        dst = out_wav_dir / f"{sid}.wav"
        concat_bilingual_wav(Path(fa_e["audio"]), Path(en_e["audio"]), dst)
        samples.append({
            "sample_id": sid,
            "source_dataset": "google/fleurs (fa_ir dev + en_us dev concatenated bilingual switch)",
            "source_utterance_id": f"{fa_e['source_utterance_id']}+{en_e['source_utterance_id']}",
            "license": "CC-BY-4.0",
            "language": "fa-en-concat",
            "audio": str(dst),
            "duration_sec": round(wav_duration(dst), 3),
            "sha256": sha256_file(dst),
            "reference": f"{fa_e['reference']} {en_e['reference']}",
        })

    manifest_path = Path("/tmp/avp-p02-bench/eval_manifest.json")
    manifest = {
        "source": "google/fleurs (dev split only — test split and PESTE Benchmark untouched)",
        "license": "CC-BY-4.0",
        "counts": {
            "fa": len(fa_canonical),
            "en": len(en_canonical),
            "fa-en-concat": sum(1 for s in samples if s["language"] == "fa-en-concat"),
            "total": len(samples),
        },
        "total_duration_sec": round(sum(s["duration_sec"] for s in samples), 2),
        "samples": samples,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in manifest.items() if k != "samples"}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
