#!/usr/bin/env python3
"""
AVAPARDAZ — PHASE-02 Turnkey Human-Review Annotation Package & IAA CLI (RECOVERY-007)

Minimizes human annotation effort for the mandatory >= 60-minute Persian word-level
manual ground-truth gate (>= 20% double-annotated IAA, <= 50 ms median / <= 150 ms P90).
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from datasets.phase02.validate_textgrid import (
    compute_iaa,
    evaluate_alignment,
    parse_textgrid,
    validate_textgrid,
)

DRAFT_SENTINEL = "UNVERIFIED_MACHINE_DRAFT"


def is_textgrid_human_verified(tg_text: str) -> bool:
    """Returns True ONLY when TextGrid parses cleanly and has cleared DRAFT_SENTINEL."""
    if DRAFT_SENTINEL in tg_text:
        return False
    tg = parse_textgrid(tg_text)
    unc_tier = tg.get_tier("annotation_uncertainty")
    if unc_tier is None:
        return False
    for iv in unc_tier.intervals:
        if DRAFT_SENTINEL in iv.text:
            return False
    return True


def generate_praat_review_script(
    manifest_items: List[Dict[str, Any]],
    annotator_role: str = "annotator_a",
) -> str:
    """Generates a turnkey Praat script stepping the annotator through their review queue."""
    lines = [
        f"# AVAPARDAZ PHASE-02 Turnkey Praat Review Script ({annotator_role})",
        "# Open in Praat: Praat -> Open Praat script -> Run.",
        "# For each clip:",
        "#   1. Adjust word onset/offset boundaries on tier 2 ('words').",
        "#   2. Label disfluencies on tier 4 ('disfluency_events') and repetitions on tier 5 ('repetition_events').",
        "#   3. Replace 'UNVERIFIED_MACHINE_DRAFT' on tier 6 ('annotation_uncertainty') with 'HUMAN_VERIFIED'.",
        "#   4. Click 'Save & Next' to save automatically and load the next clip.",
        "",
        f'writeInfoLine: "Starting AvaPardaz Phase-02 review queue ({annotator_role})..."',
        "",
    ]
    count = 0
    for item in manifest_items:
        tg_rel = item.get(f"{annotator_role}_textgrid_rel")
        if not tg_rel:
            continue
        count += 1
        wav_path = item["audio_path"]
        clip_id = item["clip_id"]
        lines.extend([
            f'appendInfoLine: "[{count}] Loading {clip_id}..."',
            f'snd = Read from file: "{wav_path}"',
            f'tg = Read from file: "{tg_rel}"',
            "selectObject: snd, tg",
            "View & Edit",
            f'beginPause: "Review {clip_id} ({count})"',
            '    comment: "Adjust word boundaries on tier 2 (words), set tier 6 (annotation_uncertainty) to HUMAN_VERIFIED, then click Save & Next."',
            'clicked = endPause: "Skip (Do Not Save)", "Save & Next", 2, 1',
            "if clicked = 2",
            "    selectObject: tg",
            f'    Save as text file: "{tg_rel}"',
            f'    appendInfoLine: "  Saved {clip_id}."',
            "endif",
            "selectObject: snd, tg",
            "Remove",
            "",
        ])
    lines.append('appendInfoLine: "Queue complete! Run review_annotation_cli.py status to validate and score IAA."')
    return "\n".join(lines) + "\n"


def evaluate_package_status(package_dir: Path) -> Dict[str, Any]:
    """Audits every clip in the annotation package and computes verified human minutes & IAA."""
    manifest_path = package_dir / "assignment_manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"Missing assignment_manifest.json in {package_dir}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    items = manifest["items"]

    total_assigned_sec = 0.0
    double_assigned_sec = 0.0
    human_verified_a_sec = 0.0
    human_verified_both_sec = 0.0
    valid_draft_count = 0
    invalid_files: List[Dict[str, Any]] = []
    draft_vs_human_shifts_ms: List[float] = []
    iaa_medians: List[float] = []
    iaa_p90s: List[float] = []
    iaa_clips_scored = 0

    for item in items:
        dur = float(item["duration_sec"])
        total_assigned_sec += dur
        is_double = bool(item.get("double_annotated_iaa", False))
        if is_double:
            double_assigned_sec += dur

        draft_p = package_dir / item["draft_textgrid_rel"]
        a_p = package_dir / item["annotator_a_textgrid_rel"]

        if draft_p.exists():
            d_tg = parse_textgrid(draft_p.read_text(encoding="utf-8"))
            d_val = validate_textgrid(d_tg, audio_duration_sec=dur, require_full_schema=True)
            if d_val["valid"]:
                valid_draft_count += 1
            else:
                invalid_files.append({"file": str(draft_p), "errors": d_val["errors"]})

        a_verified = False
        a_tg = None
        if a_p.exists():
            a_txt = a_p.read_text(encoding="utf-8")
            a_tg = parse_textgrid(a_txt)
            a_val = validate_textgrid(a_tg, audio_duration_sec=dur, require_full_schema=True)
            if not a_val["valid"]:
                invalid_files.append({"file": str(a_p), "errors": a_val["errors"]})
            elif is_textgrid_human_verified(a_txt):
                a_verified = True
                human_verified_a_sec += dur
                if draft_p.exists():
                    diff = evaluate_alignment(a_tg, parse_textgrid(draft_p.read_text(encoding="utf-8")), dur)
                    if diff["MEDIAN_BOUNDARY_ERROR_MS"] is not None:
                        draft_vs_human_shifts_ms.append(diff["MEDIAN_BOUNDARY_ERROR_MS"])

        if is_double and item.get("annotator_b_textgrid_rel"):
            b_p = package_dir / item["annotator_b_textgrid_rel"]
            if b_p.exists():
                b_txt = b_p.read_text(encoding="utf-8")
                b_tg = parse_textgrid(b_txt)
                b_val = validate_textgrid(b_tg, audio_duration_sec=dur, require_full_schema=True)
                if not b_val["valid"]:
                    invalid_files.append({"file": str(b_p), "errors": b_val["errors"]})
                elif a_verified and a_tg is not None and is_textgrid_human_verified(b_txt):
                    human_verified_both_sec += dur
                    iaa = compute_iaa(a_tg, b_tg, audio_duration_sec=dur)
                    if iaa["MEDIAN_ABSOLUTE_DISAGREEMENT_MS"] is not None:
                        iaa_medians.append(iaa["MEDIAN_ABSOLUTE_DISAGREEMENT_MS"])
                    if iaa["P90_ABSOLUTE_DISAGREEMENT_MS"] is not None:
                        iaa_p90s.append(iaa["P90_ABSOLUTE_DISAGREEMENT_MS"])
                    iaa_clips_scored += 1

    double_assigned_pct = (100.0 * double_assigned_sec / total_assigned_sec) if total_assigned_sec > 0 else 0.0
    double_verified_pct = (100.0 * human_verified_both_sec / human_verified_a_sec) if human_verified_a_sec > 0 else 0.0

    def _med(xs: List[float]) -> Optional[float]:
        if not xs:
            return None
        s = sorted(xs)
        return round(s[len(s) // 2], 2)

    iaa_med = _med(iaa_medians)
    iaa_p90 = _med(iaa_p90s)
    return {
        "package_dir": str(package_dir),
        "total_assigned_clips": len(items),
        "total_assigned_minutes": round(total_assigned_sec / 60.0, 2),
        "double_annotated_assigned_minutes": round(double_assigned_sec / 60.0, 2),
        "double_annotated_assigned_pct": round(double_assigned_pct, 2),
        "valid_machine_drafts": valid_draft_count,
        "invalid_textgrid_count": len(invalid_files),
        "invalid_files": invalid_files[:10],
        "HUMAN_VERIFIED_MINUTES": round(human_verified_a_sec / 60.0, 2),
        "HUMAN_VERIFIED_DOUBLE_ANNOTATED_MINUTES": round(human_verified_both_sec / 60.0, 2),
        "HUMAN_VERIFIED_DOUBLE_ANNOTATED_PCT": round(double_verified_pct, 2),
        "IAA_CLIPS_SCORED": iaa_clips_scored,
        "IAA_MEDIAN_DISAGREEMENT_MS": iaa_med,
        "IAA_P90_DISAGREEMENT_MS": iaa_p90,
        "IAA_TARGETS_MET": (
            iaa_med is not None and iaa_med <= 50.0 and iaa_p90 is not None and iaa_p90 <= 150.0
            and double_verified_pct >= 20.0
        ),
        "GATE_60_MIN_HUMAN_GOLD_MET": (human_verified_a_sec / 60.0) >= 60.0 and double_verified_pct >= 20.0,
        "mean_draft_to_human_shift_ms": (
            round(sum(draft_vs_human_shifts_ms) / len(draft_vs_human_shifts_ms), 2)
            if draft_vs_human_shifts_ms
            else None
        ),
    }


def build_annotation_package(
    manifest_path: Path,
    package_dir: Path,
    target_minutes: float = 61.0,
    double_fraction: float = 0.22,
    num_threads: int = 3,
    normalize_per_feature: bool = False,
) -> Dict[str, Any]:
    """Curates a speaker-diverse >= 60-min Persian review package pre-aligned with Shenava CTC Viterbi."""
    from benchmarks.phase02.persian_ctc_aligner import (
        ShenavaCTCAligner,
        aligned_words_to_textgrid,
    )

    records = [
        json.loads(ln)
        for ln in manifest_path.read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    fa_heldout = [
        r
        for r in records
        if r.get("language") == "fa"
        and str(r.get("split", "")).lower() in ("held_out", "heldout")
        and Path(r["audio_path"]).exists()
    ]

    by_spk: Dict[str, List[Dict[str, Any]]] = {}
    for r in fa_heldout:
        spk = str(r.get("speaker_id") or r.get("source_corpus") or "unknown")
        by_spk.setdefault(spk, []).append(r)

    spk_keys = sorted(by_spk.keys())
    selected: List[Dict[str, Any]] = []
    acc_sec = 0.0
    target_sec = target_minutes * 60.0
    idx = 0
    while acc_sec < target_sec:
        progressed = False
        for spk in spk_keys:
            bucket = by_spk[spk]
            if idx < len(bucket):
                clip = bucket[idx]
                selected.append(clip)
                acc_sec += float(clip["duration_sec"])
                progressed = True
                if acc_sec >= target_sec:
                    break
        if not progressed:
            break
        idx += 1

    drafts_dir = package_dir / "drafts_immutable"
    ann_a_dir = package_dir / "annotator_a"
    ann_b_dir = package_dir / "annotator_b"
    for d in (drafts_dir, ann_a_dir, ann_b_dir):
        d.mkdir(parents=True, exist_ok=True)

    aligner = ShenavaCTCAligner(num_threads=num_threads, normalize_per_feature=normalize_per_feature)
    items: List[Dict[str, Any]] = []
    double_target_sec = acc_sec * double_fraction
    double_acc_sec = 0.0

    for i, clip in enumerate(selected):
        cid = clip["clip_id"]
        dur = float(clip["duration_sec"])
        res = aligner.align_file(clip["audio_path"], transcript=clip["transcript"], energy_refine=True)
        tg_str = aligned_words_to_textgrid(
            res["words"],
            audio_duration_sec=dur,
            speaker_label=str(clip.get("speaker_id") or "SPEAKER_01"),
            language_label="fa",
            provenance_tag=DRAFT_SENTINEL,
        )

        draft_rel = f"drafts_immutable/{cid}.draft.TextGrid"
        ann_a_rel = f"annotator_a/{cid}.TextGrid"
        (package_dir / draft_rel).write_text(tg_str, encoding="utf-8")
        (package_dir / ann_a_rel).write_text(tg_str, encoding="utf-8")

        assign_double = (i % 4 == 0) or (double_acc_sec < double_target_sec and i >= len(selected) - 40)
        ann_b_rel: Optional[str] = None
        if assign_double:
            ann_b_rel = f"annotator_b/{cid}.TextGrid"
            (package_dir / ann_b_rel).write_text(tg_str, encoding="utf-8")
            double_acc_sec += dur

        items.append(
            {
                "clip_id": cid,
                "source_corpus": clip.get("source_corpus"),
                "speaker_id": clip.get("speaker_id"),
                "register_hint": clip.get("register_hint", "read_speech"),
                "license": clip.get("license"),
                "audio_path": clip["audio_path"],
                "duration_sec": dur,
                "transcript": clip["transcript"],
                "word_count_prealigned": len(res["words"]),
                "prealign_rtf": res["rtf"],
                "prealign_provider": "Reza2kn/Shenava-Rizeh-v1.0-INT8-CTC-Viterbi",
                "annotation_state": DRAFT_SENTINEL,
                "double_annotated_iaa": assign_double,
                "draft_textgrid_rel": draft_rel,
                "annotator_a_textgrid_rel": ann_a_rel,
                "annotator_b_textgrid_rel": ann_b_rel,
            }
        )

    manifest_out = {
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "execution_id": "AVP-P02-RECOVERY-007",
        "package_version": "annotation_package_v1",
        "provenance_warning": "ALL pre-aligned TextGrid files are UNVERIFIED_MACHINE_DRAFT until reviewed and saved by human annotators in Praat.",
        "total_clips": len(items),
        "total_minutes": round(acc_sec / 60.0, 2),
        "distinct_speakers": len({it["speaker_id"] for it in items}),
        "double_annotated_clips": sum(1 for it in items if it["double_annotated_iaa"]),
        "double_annotated_minutes": round(double_acc_sec / 60.0, 2),
        "double_annotated_pct": round(100.0 * double_acc_sec / max(acc_sec, 1e-6), 2),
        "iaa_targets": {"median_disagreement_ms_max": 50.0, "p90_disagreement_ms_max": 150.0, "min_double_pct": 20.0},
        "items": items,
    }
    (package_dir / "assignment_manifest.json").write_text(
        json.dumps(manifest_out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (package_dir / "review_annotator_a.praat").write_text(
        generate_praat_review_script(items, "annotator_a"), encoding="utf-8"
    )
    (package_dir / "review_annotator_b.praat").write_text(
        generate_praat_review_script(items, "annotator_b"), encoding="utf-8"
    )
    return evaluate_package_status(package_dir)


def main() -> None:
    p = argparse.ArgumentParser(description="AvaPardaz Phase-02 Turnkey Human-Review Annotation CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    pb = sub.add_parser("build-package")
    pb.add_argument("--manifest", default="datasets/phase02/manifest_v2.jsonl")
    pb.add_argument("--out-dir", default="datasets/phase02/annotation_package_v1")
    pb.add_argument("--target-minutes", type=float, default=61.0)
    pb.add_argument("--double-fraction", type=float, default=0.22)
    pb.add_argument("--num-threads", type=int, default=3)
    pb.add_argument("--no-feature-norm", action="store_true")

    ps = sub.add_parser("status")
    ps.add_argument("--package-dir", default="datasets/phase02/annotation_package_v1")

    args = p.parse_args()
    if args.cmd == "build-package":
        res = build_annotation_package(
            Path(args.manifest),
            Path(args.out_dir),
            target_minutes=args.target_minutes,
            double_fraction=args.double_fraction,
            num_threads=args.num_threads,
            normalize_per_feature=bool(getattr(args, "feature_norm", False)),
        )
        print(json.dumps(res, indent=2, ensure_ascii=False))
    elif args.cmd == "status":
        res = evaluate_package_status(Path(args.package_dir))
        print(json.dumps(res, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
