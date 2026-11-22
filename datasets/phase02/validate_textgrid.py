#!/usr/bin/env python3
"""
AVAPARDAZ — PHASE-02 Praat TextGrid Parser, Validator & Alignment Evaluator

Supports:
1. Parsing standard Praat TextGrid files (ooTextFile long format as emitted by Praat & sherpa-onnx-fa).
2. Validating word/phone/event interval invariants:
   - word_start >= 0
   - word_end > word_start
   - word_end <= audio_duration (+ configurable epsilon)
   - Chronological consistency within each tier
   - Preserving legitimate multi-speaker overlapping speech across speaker tiers
3. Computing Inter-Annotator Agreement (IAA) boundary disagreement (median, P90) & word agreement.
4. Computing Alignment Quality metrics against reference boundaries:
   - WORD_TIMESTAMP_COVERAGE
   - MEDIAN_BOUNDARY_ERROR_MS, P90_BOUNDARY_ERROR_MS, P95_BOUNDARY_ERROR_MS
   - INVALID_INTERVAL_COUNT, MISSING_ALIGNMENT_COUNT, OVERLAPPING_INTERVAL_COUNT
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


REQUIRED_HUMAN_TIERS = (
    "speaker",
    "words",
    "language",
    "disfluency_events",
    "repetition_events",
    "annotation_uncertainty",
)


@dataclass
class Interval:
    xmin: float
    xmax: float
    text: str


@dataclass
class Tier:
    name: str
    tier_class: str
    xmin: float
    xmax: float
    intervals: List[Interval]


@dataclass
class TextGrid:
    xmin: float
    xmax: float
    tiers: List[Tier]

    def get_tier(self, name: str) -> Optional[Tier]:
        target = name.strip().lower()
        for t in self.tiers:
            if t.name.strip().lower() == target:
                return t
        return None


def parse_textgrid(content: str) -> TextGrid:
    """Parses Praat long-format ooTextFile TextGrid."""
    lines = [ln.strip() for ln in content.splitlines() if ln.strip()]
    if not lines or "ooTextFile" not in lines[0]:
        raise ValueError("Invalid TextGrid header: missing 'ooTextFile'")

    tg_xmin = 0.0
    tg_xmax = 0.0
    tiers: List[Tier] = []

    i = 0
    n = len(lines)
    while i < n:
        ln = lines[i]
        if ln.startswith("xmin =") and not tiers and tg_xmax == 0.0:
            tg_xmin = float(ln.split("=", 1)[1].strip())
        elif ln.startswith("xmax =") and not tiers and tg_xmax == 0.0:
            tg_xmax = float(ln.split("=", 1)[1].strip())
        elif re.match(r"^item\s*\[\d+\]:$", ln):
            i += 1
            t_class = "IntervalTier"
            t_name = ""
            t_xmin = tg_xmin
            t_xmax = tg_xmax
            intervals: List[Interval] = []
            while i < n and not re.match(r"^item\s*\[\d+\]:$", lines[i]):
                cur = lines[i]
                if cur.startswith("class ="):
                    t_class = cur.split("=", 1)[1].strip().strip('"')
                elif cur.startswith("name ="):
                    t_name = cur.split("=", 1)[1].strip().strip('"')
                elif cur.startswith("xmin =") and not intervals:
                    t_xmin = float(cur.split("=", 1)[1].strip())
                elif cur.startswith("xmax =") and not intervals:
                    t_xmax = float(cur.split("=", 1)[1].strip())
                elif re.match(r"^intervals\s*\[\d+\]:$", cur):
                    ixmin, ixmax, itext = 0.0, 0.0, ""
                    i += 1
                    while i < n and not re.match(r"^(intervals\s*\[\d+\]:|item\s*\[\d+\]:)$", lines[i]):
                        sub = lines[i]
                        if sub.startswith("xmin ="):
                            ixmin = float(sub.split("=", 1)[1].strip())
                        elif sub.startswith("xmax ="):
                            ixmax = float(sub.split("=", 1)[1].strip())
                        elif sub.startswith("text ="):
                            raw_t = sub.split("=", 1)[1].strip()
                            if raw_t.startswith('"') and raw_t.endswith('"') and len(raw_t) >= 2:
                                raw_t = raw_t[1:-1].replace('""', '"')
                            itext = raw_t
                        i += 1
                    intervals.append(Interval(xmin=ixmin, xmax=ixmax, text=itext))
                    continue
                i += 1
            tiers.append(Tier(name=t_name, tier_class=t_class, xmin=t_xmin, xmax=t_xmax, intervals=intervals))
            continue
        i += 1

    return TextGrid(xmin=tg_xmin, xmax=tg_xmax, tiers=tiers)


def write_textgrid(tg: TextGrid) -> str:
    """Serializes TextGrid to standard Praat ooTextFile long format."""
    out = [
        'File type = "ooTextFile"',
        'Object class = "TextGrid"',
        "",
        f"xmin = {tg.xmin}",
        f"xmax = {tg.xmax}",
        "tiers? <exists>",
        f"size = {len(tg.tiers)}",
        "item []:",
    ]
    for tidx, tier in enumerate(tg.tiers, start=1):
        out.append(f"    item [{tidx}]:")
        out.append(f'        class = "{tier.tier_class}"')
        out.append(f'        name = "{tier.name}"')
        out.append(f"        xmin = {tier.xmin}")
        out.append(f"        xmax = {tier.xmax}")
        out.append(f"        intervals: size = {len(tier.intervals)}")
        for iidx, iv in enumerate(tier.intervals, start=1):
            escaped = iv.text.replace('"', '""')
            out.append(f"        intervals [{iidx}]:")
            out.append(f"            xmin = {iv.xmin}")
            out.append(f"            xmax = {iv.xmax}")
            out.append(f'            text = "{escaped}"')
    return "\n".join(out) + "\n"


def validate_textgrid(
    tg: TextGrid,
    audio_duration_sec: float,
    require_full_schema: bool = False,
    duration_tolerance_sec: float = 0.05,
) -> Dict[str, Any]:
    """
    Validates interval bounds, chronology, overlap handling, and optional 6-tier human schema.
    Overlapping intervals WITHIN a single word tier are flagged; overlaps ACROSS distinct
    speaker tiers (e.g., speaker_1 / speaker_2 or speaker tier) are preserved as valid overlap.
    """
    errors: List[str] = []
    warnings: List[str] = []
    invalid_interval_count = 0
    within_tier_overlap_count = 0
    non_monotonic_count = 0
    cross_speaker_overlap_count = 0

    tier_names = [t.name.strip().lower() for t in tg.tiers]
    if require_full_schema:
        for req in REQUIRED_HUMAN_TIERS:
            if req not in tier_names:
                errors.append(f"Missing required human annotation tier: '{req}'")

    speaker_word_tiers: List[Tier] = []
    for tier in tg.tiers:
        if tier.name.strip().lower().startswith("words"):
            speaker_word_tiers.append(tier)
        prev_end: Optional[float] = None
        prev_start: Optional[float] = None
        for idx, iv in enumerate(tier.intervals, start=1):
            is_bad = False
            if iv.xmin < -1e-6:
                errors.append(f"Tier '{tier.name}' interval[{idx}]: word_start ({iv.xmin}) < 0")
                is_bad = True
            if iv.xmax <= iv.xmin:
                errors.append(f"Tier '{tier.name}' interval[{idx}]: word_end ({iv.xmax}) <= word_start ({iv.xmin})")
                is_bad = True
            if iv.xmax > audio_duration_sec + duration_tolerance_sec:
                errors.append(
                    f"Tier '{tier.name}' interval[{idx}]: word_end ({iv.xmax:.4f}) > audio_duration ({audio_duration_sec:.4f})"
                )
                is_bad = True
            if is_bad:
                invalid_interval_count += 1
            if prev_start is not None and iv.xmin < prev_start - 1e-6:
                errors.append(f"Tier '{tier.name}' interval[{idx}]: non-chronological start {iv.xmin} < {prev_start}")
                non_monotonic_count += 1
            if prev_end is not None and iv.xmin < prev_end - 1e-4:
                errors.append(f"Tier '{tier.name}' interval[{idx}]: intra-tier overlap {iv.xmin} < prev_end {prev_end}")
                within_tier_overlap_count += 1
            prev_start = iv.xmin
            prev_end = iv.xmax

    # Legitimate multi-speaker overlap detection (informational — NOT an error)
    if len(speaker_word_tiers) > 1:
        for i in range(len(speaker_word_tiers)):
            for j in range(i + 1, len(speaker_word_tiers)):
                for a in speaker_word_tiers[i].intervals:
                    if not a.text.strip():
                        continue
                    for b in speaker_word_tiers[j].intervals:
                        if not b.text.strip():
                            continue
                        if max(a.xmin, b.xmin) < min(a.xmax, b.xmax) - 1e-4:
                            cross_speaker_overlap_count += 1

    if cross_speaker_overlap_count > 0:
        warnings.append(
            f"Preserved {cross_speaker_overlap_count} legitimate cross-speaker overlapping word interval pair(s)."
        )

    return {
        "valid": len(errors) == 0,
        "tier_count": len(tg.tiers),
        "tier_names": [t.name for t in tg.tiers],
        "invalid_interval_count": invalid_interval_count,
        "within_tier_overlap_count": within_tier_overlap_count,
        "non_monotonic_count": non_monotonic_count,
        "preserved_cross_speaker_overlaps": cross_speaker_overlap_count,
        "errors": errors,
        "warnings": warnings,
    }


def _percentile(values: List[float], pct: float) -> Optional[float]:
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * (pct / 100.0)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return s[int(k)]
    return s[f] + (s[c] - s[f]) * (k - f)


def _norm_token(tok: str) -> str:
    cleaned = re.sub(r"[^\w\u0600-\u06FF\u200c']+", "", tok.strip().lower())
    return cleaned


def extract_nonempty_words(tg: TextGrid, tier_name: str = "words") -> List[Interval]:
    tier = tg.get_tier(tier_name)
    if tier is None:
        # Fallback to first tier whose name contains 'word'
        for t in tg.tiers:
            if "word" in t.name.lower():
                tier = t
                break
    if tier is None:
        return []
    return [iv for iv in tier.intervals if _norm_token(iv.text)]


def align_word_sequences(
    ref_words: List[Interval],
    hyp_words: List[Interval],
) -> Tuple[List[Tuple[Interval, Interval]], int, int]:
    """
    LCS-based monotonic alignment of normalized word sequences so boundary errors are
    computed only on matched word tokens while explicitly counting missing alignments.
    """
    r_toks = [_norm_token(w.text) for w in ref_words]
    h_toks = [_norm_token(w.text) for w in hyp_words]
    m, n = len(r_toks), len(h_toks)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m - 1, -1, -1):
        for j in range(n - 1, -1, -1):
            if r_toks[i] == h_toks[j]:
                dp[i][j] = 1 + dp[i + 1][j + 1]
            else:
                dp[i][j] = max(dp[i + 1][j], dp[i][j + 1])

    matched: List[Tuple[Interval, Interval]] = []
    i = j = 0
    while i < m and j < n:
        if r_toks[i] == h_toks[j]:
            matched.append((ref_words[i], hyp_words[j]))
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1

    missing_ref = m - len(matched)
    extra_hyp = n - len(matched)
    return matched, missing_ref, extra_hyp


def evaluate_alignment(
    ref_tg: TextGrid,
    hyp_tg: TextGrid,
    audio_duration_sec: float,
    ref_tier: str = "words",
    hyp_tier: str = "words",
) -> Dict[str, Any]:
    """Evaluates hypothesis word boundaries against reference word boundaries."""
    hyp_val = validate_textgrid(hyp_tg, audio_duration_sec=audio_duration_sec, require_full_schema=False)
    ref_words = extract_nonempty_words(ref_tg, ref_tier)
    hyp_words = extract_nonempty_words(hyp_tg, hyp_tier)
    matched, missing_count, extra_count = align_word_sequences(ref_words, hyp_words)

    boundary_errors_ms: List[float] = []
    start_errors_ms: List[float] = []
    end_errors_ms: List[float] = []
    for rw, hw in matched:
        se = abs(hw.xmin - rw.xmin) * 1000.0
        ee = abs(hw.xmax - rw.xmax) * 1000.0
        start_errors_ms.append(se)
        end_errors_ms.append(ee)
        boundary_errors_ms.extend([se, ee])

    coverage = (len(matched) / len(ref_words)) if ref_words else 0.0
    return {
        "ref_word_count": len(ref_words),
        "hyp_word_count": len(hyp_words),
        "matched_word_count": len(matched),
        "WORD_TIMESTAMP_COVERAGE": round(coverage, 4),
        "MEDIAN_BOUNDARY_ERROR_MS": round(_percentile(boundary_errors_ms, 50) or 0.0, 2) if boundary_errors_ms else None,
        "P90_BOUNDARY_ERROR_MS": round(_percentile(boundary_errors_ms, 90) or 0.0, 2) if boundary_errors_ms else None,
        "P95_BOUNDARY_ERROR_MS": round(_percentile(boundary_errors_ms, 95) or 0.0, 2) if boundary_errors_ms else None,
        "MEDIAN_START_ERROR_MS": round(_percentile(start_errors_ms, 50) or 0.0, 2) if start_errors_ms else None,
        "MEDIAN_END_ERROR_MS": round(_percentile(end_errors_ms, 50) or 0.0, 2) if end_errors_ms else None,
        "INVALID_INTERVAL_COUNT": hyp_val["invalid_interval_count"],
        "MISSING_ALIGNMENT_COUNT": missing_count,
        "EXTRA_HYP_WORD_COUNT": extra_count,
        "OVERLAPPING_INTERVAL_COUNT": hyp_val["within_tier_overlap_count"],
    }


def compute_iaa(annotator_a: TextGrid, annotator_b: TextGrid, audio_duration_sec: float) -> Dict[str, Any]:
    """
    Computes Inter-Annotator Agreement (IAA) between two independent human annotators.
    Targets: MEDIAN_ABSOLUTE_DISAGREEMENT <= 50 ms, P90_ABSOLUTE_DISAGREEMENT <= 150 ms.
    """
    res = evaluate_alignment(annotator_a, annotator_b, audio_duration_sec=audio_duration_sec)
    denom = max(res["ref_word_count"], res["hyp_word_count"], 1)
    word_agreement = res["matched_word_count"] / denom
    med = res["MEDIAN_BOUNDARY_ERROR_MS"]
    p90 = res["P90_BOUNDARY_ERROR_MS"]
    return {
        "word_transcription_agreement": round(word_agreement, 4),
        "MEDIAN_ABSOLUTE_DISAGREEMENT_MS": med,
        "P90_ABSOLUTE_DISAGREEMENT_MS": p90,
        "meets_median_target_le_50ms": (med is not None and med <= 50.0),
        "meets_p90_target_le_150ms": (p90 is not None and p90 <= 150.0),
        "matched_words": res["matched_word_count"],
        "annotator_a_words": res["ref_word_count"],
        "annotator_b_words": res["hyp_word_count"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate Praat TextGrid or evaluate alignment/IAA.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_val = sub.add_parser("validate")
    p_val.add_argument("--textgrid", required=True)
    p_val.add_argument("--duration", type=float, required=True)
    p_val.add_argument("--require-full-schema", action="store_true")

    p_eval = sub.add_parser("evaluate")
    p_eval.add_argument("--ref", required=True)
    p_eval.add_argument("--hyp", required=True)
    p_eval.add_argument("--duration", type=float, required=True)

    p_iaa = sub.add_parser("iaa")
    p_iaa.add_argument("--annotator-a", required=True)
    p_iaa.add_argument("--annotator-b", required=True)
    p_iaa.add_argument("--duration", type=float, required=True)

    args = parser.parse_args()
    if args.cmd == "validate":
        tg = parse_textgrid(Path(args.textgrid).read_text(encoding="utf-8"))
        res = validate_textgrid(tg, audio_duration_sec=args.duration, require_full_schema=args.require_full_schema)
        print(json.dumps(res, indent=2, ensure_ascii=False))
        sys.exit(0 if res["valid"] else 1)
    elif args.cmd == "evaluate":
        ref_tg = parse_textgrid(Path(args.ref).read_text(encoding="utf-8"))
        hyp_tg = parse_textgrid(Path(args.hyp).read_text(encoding="utf-8"))
        print(json.dumps(evaluate_alignment(ref_tg, hyp_tg, audio_duration_sec=args.duration), indent=2, ensure_ascii=False))
    elif args.cmd == "iaa":
        tg_a = parse_textgrid(Path(args.annotator_a).read_text(encoding="utf-8"))
        tg_b = parse_textgrid(Path(args.annotator_b).read_text(encoding="utf-8"))
        print(json.dumps(compute_iaa(tg_a, tg_b, audio_duration_sec=args.duration), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
