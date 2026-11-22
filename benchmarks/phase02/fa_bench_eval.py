#!/usr/bin/env python3
"""
AVAPARDAZ — PHASE-02 FA-Bench Dual-Track Forced Alignment Evaluator (RECOVERY-007)

Implements dual-track word-level alignment evaluation adapted from Olewave FA-Bench
(arXiv:2609.32396, https://github.com/olewave/fa-bench):

  Track A — Reference Transcript Alignment:
    Aligner receives the verified reference transcript; isolates pure acoustic/temporal
    alignment accuracy independent of ASR recognition errors.

  Track B — Recognition-Driven Alignment:
    Aligner receives the ASR-generated hypothesis transcript; evaluates full product
    pipeline and explicitly penalizes ASR insertions, deletions, substitutions,
    unaligned words, and invalid neighboring boundaries via strict 1-to-1
    tolerance-based Boundary Precision / Recall / F1.

Predefined Evaluation Tolerances (locked before testing):
  - 20 ms (FA-Bench literature comparability)
  - 25 ms, 50 ms, 100 ms, 150 ms (AvaPardaz Phase-02 editing gates)

Strict Provenance Discipline:
  - Repeated words are always preserved as independent sequential events.
  - Onset (start) and offset (end) errors are measured and reported separately.
  - Machine-to-machine comparisons MUST be tagged `INTER_SYSTEM_COMPARISON_ONLY`
    and are never reported as human-verified ground truth.
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

PREDEFINED_TOLERANCES_MS: Tuple[int, ...] = (20, 25, 50, 100, 150)

# Needleman-Wunsch scoring constants (identical to FA-Bench fabench/score/matched.py)
_NW_MATCH = 2
_NW_MISMATCH = -1
_NW_GAP = -1
_TOL_GUARD_S = 1e-9


@dataclass(frozen=True)
class WordInterval:
    word: str
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


def normalize_word_label(token: str) -> str:
    """Canonicalizes Persian/English word tokens for label matching without merging words."""
    if not token:
        return ""
    s = unicodedata.normalize("NFKC", token.strip().lower())
    # Arabic -> Persian canonical glyphs
    s = (
        s.replace("\u064a", "\u06cc")  # Arabic yeh -> Persian yeh
        .replace("\u0649", "\u06cc")   # Alef maksura -> Persian yeh
        .replace("\u0643", "\u06a9")   # Arabic kaf -> Persian kaf
        .replace("\u0629", "\u0647")   # Teh marbuta -> Heh
        .replace("\u0622", "\u0627")   # Alef madda -> Alef
        .replace("\u0623", "\u0627")   # Alef hamza above -> Alef
        .replace("\u0625", "\u0627")   # Alef hamza below -> Alef
        .replace("\u0624", "\u0648")   # Waw hamza -> Waw
        .replace("\u0626", "\u06cc")   # Yeh hamza -> Yeh
        .replace("\u0640", "")         # Tatweel
    )
    # Strip Persian/Arabic short vowel diacritics
    s = re.sub(r"[\u064B-\u065F\u0670]", "", s)
    # Remove ZWNJ and punctuation while keeping Persian/Latin letters & digits
    s = s.replace("\u200c", "")
    s = re.sub(r"[^\w\u0600-\u06FF]+", "", s)
    return s


def nw_align_labels(
    ref_labels: Sequence[str],
    hyp_labels: Sequence[str],
) -> List[Tuple[Optional[int], Optional[int]]]:
    """
    Monotonic global Needleman-Wunsch alignment over canonicalized labels.
    Preserves repeated identical words as separate sequential events.
    """
    n, m = len(ref_labels), len(hyp_labels)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = i * _NW_GAP
    for j in range(1, m + 1):
        dp[0][j] = j * _NW_GAP

    for i in range(1, n + 1):
        ri = ref_labels[i - 1]
        row = dp[i]
        prev = dp[i - 1]
        for j in range(1, m + 1):
            sub_score = _NW_MATCH if ri == hyp_labels[j - 1] else _NW_MISMATCH
            row[j] = max(
                prev[j - 1] + sub_score,
                prev[j] + _NW_GAP,
                row[j - 1] + _NW_GAP,
            )

    pairs: List[Tuple[Optional[int], Optional[int]]] = []
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            sub_score = _NW_MATCH if ref_labels[i - 1] == hyp_labels[j - 1] else _NW_MISMATCH
            if dp[i][j] == dp[i - 1][j - 1] + sub_score:
                pairs.append((i - 1, j - 1))
                i -= 1
                j -= 1
                continue
        if i > 0 and dp[i][j] == dp[i - 1][j] + _NW_GAP:
            pairs.append((i - 1, None))
            i -= 1
            continue
        pairs.append((None, j - 1))
        j -= 1
    pairs.reverse()
    return pairs


def validate_word_intervals(
    words: Sequence[WordInterval],
    audio_duration_sec: float,
    duration_tolerance_sec: float = 0.05,
) -> Dict[str, Any]:
    """Checks interval validity, monotonicity, and intra-tier overlaps."""
    invalid_count = 0
    overlap_count = 0
    non_monotonic_count = 0
    prev_start: Optional[float] = None
    prev_end: Optional[float] = None

    for w in words:
        bad = False
        if not math.isfinite(w.start) or not math.isfinite(w.end):
            bad = True
        elif w.start < -1e-6 or w.end <= w.start or w.end > audio_duration_sec + duration_tolerance_sec:
            bad = True
        if bad:
            invalid_count += 1
        if prev_start is not None and w.start < prev_start - 1e-6:
            non_monotonic_count += 1
        if prev_end is not None and w.start < prev_end - 1e-4:
            overlap_count += 1
        prev_start = w.start
        prev_end = w.end

    total = len(words)
    return {
        "word_count": total,
        "invalid_interval_count": invalid_count,
        "invalid_interval_rate": (invalid_count / total) if total > 0 else 0.0,
        "overlap_count": overlap_count,
        "non_monotonic_count": non_monotonic_count,
    }


def _percentile(values: Sequence[float], pct: float) -> Optional[float]:
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * (pct / 100.0)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return float(s[int(k)])
    return float(s[f] + (s[c] - s[f]) * (k - f))


def _dedup_boundaries(
    words: Sequence[WordInterval],
) -> List[Tuple[float, Optional[int], Optional[int]]]:
    """
    Returns deduplicated boundary events as (time_sec, left_word_idx, right_word_idx).
    Adjacent contiguous words share one interior boundary so interior joints are not
    double-weighted relative to utterance edges (per FA-Bench fabench/score/word.py).
    """
    sides: Dict[float, List[Optional[int]]] = {}
    for i, w in enumerate(words):
        k_start = round(w.start, 6)
        k_end = round(w.end, 6)
        sides.setdefault(k_start, [None, None])[1] = i
        sides.setdefault(k_end, [None, None])[0] = i
    out = [(t, lr[0], lr[1]) for t, lr in sorted(sides.items(), key=lambda x: x[0])]
    return out


def _compute_word_iou(a: WordInterval, b: WordInterval) -> float:
    inter = max(0.0, min(a.end, b.end) - max(a.start, b.start))
    union = max(a.end, b.end) - min(a.start, b.start)
    if union <= 0.0:
        return 0.0
    return inter / union


def evaluate_utterance_dual_track(
    ref_words: Sequence[WordInterval],
    hyp_words: Sequence[WordInterval],
    audio_duration_sec: float,
    track: str,
    tolerances_ms: Sequence[int] = PREDEFINED_TOLERANCES_MS,
) -> Dict[str, Any]:
    """
    Evaluates one utterance under FA-Bench Track A or Track B.
    """
    if track not in ("TRACK_A_REFERENCE", "TRACK_B_ASR_HYPOTHESIS"):
        raise ValueError(f"Unsupported track: {track}")

    hyp_val = validate_word_intervals(hyp_words, audio_duration_sec=audio_duration_sec)

    ref_norm = [normalize_word_label(w.word) for w in ref_words]
    hyp_norm = [normalize_word_label(w.word) for w in hyp_words]

    pairs = nw_align_labels(ref_norm, hyp_norm)
    matched_pairs: List[Tuple[int, int]] = []
    substitutions = 0
    deletions = 0
    insertions = 0
    for gi, hj in pairs:
        if gi is not None and hj is not None:
            if ref_norm[gi] == hyp_norm[hj] and ref_norm[gi] != "":
                matched_pairs.append((gi, hj))
            else:
                substitutions += 1
        elif gi is not None:
            deletions += 1
        elif hj is not None:
            insertions += 1

    matched_map = dict(matched_pairs)
    rev_matched_map = {hj: gi for gi, hj in matched_pairs}

    # Per-word onset & offset errors on matched words (separately tracked!)
    start_errors_ms: List[float] = []
    end_errors_ms: List[float] = []
    ious: List[float] = []
    for gi, hj in matched_pairs:
        rw = ref_words[gi]
        hw = hyp_words[hj]
        start_errors_ms.append(abs(hw.start - rw.start) * 1000.0)
        end_errors_ms.append(abs(hw.end - rw.end) * 1000.0)
        ious.append(_compute_word_iou(rw, hw))

    # Deduplicated boundary evaluation (FA-Bench strict boundary matching)
    ref_bounds = _dedup_boundaries(ref_words)
    hyp_bounds = _dedup_boundaries(hyp_words)

    matched_boundary_errors_ms: List[float] = []
    # Also track strict 1-to-1 boundary hits per tolerance with label-checked neighbors:
    # A reference boundary hits iff every adjacent ref word is matched AND the corresponding
    # hypothesis boundary lies within tolerance AND does not collide with another hit.
    candidate_hits: List[Tuple[float, int, int]] = []
    # Map hypothesis boundary index by (left_hyp_idx, right_hyp_idx) or time lookup
    for r_bidx, (r_t, r_left, r_right) in enumerate(ref_bounds):
        near = [idx for idx in (r_left, r_right) if idx is not None]
        if not near or not all(idx in matched_map for idx in near):
            continue
        # Corresponding hypothesis time (prefer left unit's end, else right unit's start)
        if r_left is not None:
            h_time = hyp_words[matched_map[r_left]].end
        else:
            assert r_right is not None
            h_time = hyp_words[matched_map[r_right]].start
        err_ms = abs(h_time - r_t) * 1000.0
        matched_boundary_errors_ms.append(err_ms)

        # Find closest matching hypothesis boundary whose matched neighbors correspond
        best_hb = None
        best_dist = float("inf")
        for h_bidx, (h_t, h_left, h_right) in enumerate(hyp_bounds):
            # Verify no invalid/unmatched neighbor at this hyp boundary
            h_near = [idx for idx in (h_left, h_right) if idx is not None]
            if not all(idx in rev_matched_map for idx in h_near):
                continue
            d = abs(h_t - r_t)
            if d < best_dist:
                best_dist = d
                best_hb = h_bidx
        if best_hb is not None:
            candidate_hits.append((best_dist * 1000.0, r_bidx, best_hb))

    candidate_hits.sort(key=lambda x: x[0])
    used_r: set[int] = set()
    used_h: set[int] = set()
    matched_strict_dists_ms: List[float] = []
    for dist_ms, r_bidx, h_bidx in candidate_hits:
        if r_bidx in used_r or h_bidx in used_h:
            continue
        used_r.add(r_bidx)
        used_h.add(h_bidx)
        matched_strict_dists_ms.append(dist_ms)

    n_gold_bounds = len(ref_bounds)
    n_hyp_bounds = len(hyp_bounds)
    tol_metrics: Dict[str, Dict[str, float]] = {}
    for tol in tolerances_ms:
        hits = sum(1 for d in matched_strict_dists_ms if d <= tol + _TOL_GUARD_S * 1000.0)
        prec = (hits / n_hyp_bounds) if n_hyp_bounds > 0 else 0.0
        rec = (hits / n_gold_bounds) if n_gold_bounds > 0 else 0.0
        f1 = (2.0 * prec * rec / (prec + rec)) if (prec + rec) > 0.0 else 0.0
        tol_metrics[f"{tol}ms"] = {
            "hits": hits,
            "n_ref_boundaries": n_gold_bounds,
            "n_hyp_boundaries": n_hyp_bounds,
            "precision": round(prec, 4),
            "recall": round(rec, 4),
            "f1": round(f1, 4),
        }

    # Check repeated consecutive words preservation
    ref_repeats = sum(
        1 for i in range(1, len(ref_norm)) if ref_norm[i] and ref_norm[i] == ref_norm[i - 1]
    )
    hyp_repeats_preserved = 0
    for i in range(1, len(ref_norm)):
        if ref_norm[i] and ref_norm[i] == ref_norm[i - 1]:
            if (i - 1) in matched_map and i in matched_map and matched_map[i] != matched_map[i - 1]:
                hyp_repeats_preserved += 1

    n_ref = len(ref_words)
    n_hyp = len(hyp_words)
    missing_words = n_ref - len(matched_pairs)

    return {
        "track": track,
        "ref_word_count": n_ref,
        "hyp_word_count": n_hyp,
        "matched_word_count": len(matched_pairs),
        "substitutions": substitutions,
        "deletions": deletions,
        "insertions": insertions,
        "WORD_COVERAGE": round((len(matched_pairs) / n_ref) if n_ref > 0 else 0.0, 4),
        "MISSING_WORD_RATE": round((missing_words / n_ref) if n_ref > 0 else 0.0, 4),
        "INVALID_INTERVAL_RATE": round(hyp_val["invalid_interval_rate"], 4),
        "invalid_interval_count": hyp_val["invalid_interval_count"],
        "overlap_count": hyp_val["overlap_count"],
        "non_monotonic_count": hyp_val["non_monotonic_count"],
        "ref_repeated_pairs": ref_repeats,
        "hyp_repeated_pairs_preserved": hyp_repeats_preserved,
        "start_errors_ms": start_errors_ms,
        "end_errors_ms": end_errors_ms,
        "boundary_errors_ms": matched_boundary_errors_ms,
        "ious": ious,
        "tolerance_f1": tol_metrics,
        "n_ref_boundaries": n_gold_bounds,
        "n_hyp_boundaries": n_hyp_bounds,
        "strict_boundary_dists_ms": matched_strict_dists_ms,
    }


def aggregate_dual_track(
    utterance_results: Sequence[Dict[str, Any]],
    track: str,
    reference_provenance: str,
    tolerances_ms: Sequence[int] = PREDEFINED_TOLERANCES_MS,
) -> Dict[str, Any]:
    """
    Aggregates FA-Bench Dual-Track results across a corpus of utterances.
    `reference_provenance` MUST be either 'HUMAN_VERIFIED_GOLD' or 'INTER_SYSTEM_COMPARISON_ONLY'.
    """
    if reference_provenance not in ("HUMAN_VERIFIED_GOLD", "INTER_SYSTEM_COMPARISON_ONLY"):
        raise ValueError(f"Invalid reference_provenance: {reference_provenance}")

    all_starts: List[float] = []
    all_ends: List[float] = []
    all_bounds: List[float] = []
    all_ious: List[float] = []
    total_ref_words = 0
    total_hyp_words = 0
    total_matched = 0
    total_subs = 0
    total_dels = 0
    total_ins = 0
    total_invalid = 0
    total_overlaps = 0
    total_non_mono = 0
    total_ref_bounds = 0
    total_hyp_bounds = 0
    total_ref_repeats = 0
    total_hyp_repeats = 0
    hits_by_tol = {tol: 0 for tol in tolerances_ms}

    for r in utterance_results:
        all_starts.extend(r["start_errors_ms"])
        all_ends.extend(r["end_errors_ms"])
        all_bounds.extend(r["boundary_errors_ms"])
        all_ious.extend(r["ious"])
        total_ref_words += r["ref_word_count"]
        total_hyp_words += r["hyp_word_count"]
        total_matched += r["matched_word_count"]
        total_subs += r["substitutions"]
        total_dels += r["deletions"]
        total_ins += r["insertions"]
        total_invalid += r["invalid_interval_count"]
        total_overlaps += r["overlap_count"]
        total_non_mono += r["non_monotonic_count"]
        total_ref_bounds += r["n_ref_boundaries"]
        total_hyp_bounds += r["n_hyp_boundaries"]
        total_ref_repeats += r["ref_repeated_pairs"]
        total_hyp_repeats += r["hyp_repeated_pairs_preserved"]
        for tol in tolerances_ms:
            hits_by_tol[tol] += r["tolerance_f1"][f"{tol}ms"]["hits"]

    tol_summary: Dict[str, Dict[str, Any]] = {}
    for tol in tolerances_ms:
        hits = hits_by_tol[tol]
        prec = (hits / total_hyp_bounds) if total_hyp_bounds > 0 else 0.0
        rec = (hits / total_ref_bounds) if total_ref_bounds > 0 else 0.0
        f1 = (2.0 * prec * rec / (prec + rec)) if (prec + rec) > 0.0 else 0.0
        pct_within_matched = (
            (sum(1 for e in all_bounds if e <= tol + 1e-6) / len(all_bounds))
            if all_bounds
            else 0.0
        )
        tol_summary[f"{tol}ms"] = {
            "hits": hits,
            "precision": round(prec, 4),
            "recall": round(rec, 4),
            "f1": round(f1, 4),
            "matched_boundary_accuracy": round(pct_within_matched, 4),
        }

    def _stats(vals: Sequence[float]) -> Dict[str, Optional[float]]:
        if not vals:
            return {"mae_ms": None, "median_ms": None, "p90_ms": None, "p95_ms": None}
        return {
            "mae_ms": round(sum(vals) / len(vals), 2),
            "median_ms": round(_percentile(vals, 50) or 0.0, 2),
            "p90_ms": round(_percentile(vals, 90) or 0.0, 2),
            "p95_ms": round(_percentile(vals, 95) or 0.0, 2),
        }

    bound_stats = _stats(all_bounds)
    start_stats = _stats(all_starts)
    end_stats = _stats(all_ends)
    missing_words = total_ref_words - total_matched

    return {
        "track": track,
        "reference_provenance": reference_provenance,
        "gold_verified": reference_provenance == "HUMAN_VERIFIED_GOLD",
        "utterances": len(utterance_results),
        "total_ref_words": total_ref_words,
        "total_hyp_words": total_hyp_words,
        "total_matched_words": total_matched,
        "substitutions": total_subs,
        "deletions": total_dels,
        "insertions": total_ins,
        "WORD_COVERAGE": round((total_matched / total_ref_words) if total_ref_words > 0 else 0.0, 4),
        "MISSING_WORD_RATE": round((missing_words / total_ref_words) if total_ref_words > 0 else 0.0, 4),
        "INVALID_INTERVAL_RATE": round((total_invalid / total_hyp_words) if total_hyp_words > 0 else 0.0, 4),
        "invalid_interval_count": total_invalid,
        "overlap_count": total_overlaps,
        "non_monotonic_count": total_non_mono,
        "START_BOUNDARY_ERROR_MS": start_stats,
        "END_BOUNDARY_ERROR_MS": end_stats,
        "MEDIAN_BOUNDARY_ERROR_MS": bound_stats["median_ms"],
        "MAE_BOUNDARY_ERROR_MS": bound_stats["mae_ms"],
        "P90_BOUNDARY_ERROR_MS": bound_stats["p90_ms"],
        "P95_BOUNDARY_ERROR_MS": bound_stats["p95_ms"],
        "MEAN_WORD_IOU": round((sum(all_ious) / len(all_ious)), 4) if all_ious else None,
        "repeated_word_pairs_ref": total_ref_repeats,
        "repeated_word_pairs_preserved": total_hyp_repeats,
        "tolerance_f1": tol_summary,
    }
