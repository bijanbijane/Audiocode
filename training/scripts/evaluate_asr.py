#!/usr/bin/env python3
"""
AVAPARDAZ — Canonical Persian / English / Code-Switch ASR Evaluation Library
Shared across PHASE-02 (CPU Model Bake-off) and PHASE-06 (Model Specialization).

Provides:
- Deterministic FA-RELAXED-V1 Persian normalization (Yeh/Kaf, ZWNJ, diacritics, numerals, punctuation)
- English normalization (lowercase, punctuation, whitespace)
- Dual reporting: BOTH Raw (unnormalized) and Normalized CER & WER
- Mixed-language / Code-Switching CER, WER, and Latin-token recall
- Paired Bootstrap 95% Confidence Intervals (10,000 iterations, seed=42)
- Zero external dependencies (pure Python 3.11 stdlib)
"""

from __future__ import annotations

import hashlib
import math
import random
import re
import unicodedata
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

# Arabic -> Persian character map + diacritics removal (FA-RELAXED-V1)
_PERSIAN_CHAR_MAP = str.maketrans({
    "\u064a": "\u06cc",  # Arabic Yeh -> Persian Yeh (ي -> ی)
    "\u0649": "\u06cc",  # Alef Maksura -> Persian Yeh (ى -> ی)
    "\u0643": "\u06a9",  # Arabic Kaf -> Persian Kaf (ك -> ک)
    "\u0623": "\u0627",  # Alef with Hamza Above -> Alef (أ -> ا)
    "\u0625": "\u0627",  # Alef with Hamza Below -> Alef (إ -> ا)
    "\u0622": "\u0627",  # Alef Madda -> Alef (آ -> ا) for relaxed acoustic comparison
    "\u0629": "\u0647",  # Teh Marbuta -> Heh (ة -> ه)
    "\u06c0": "\u0647",  # Heh with Yeh Above -> Heh (ۀ -> ه)
    # Persian & Arabic-Indic digits -> ASCII digits for consistent CER/WER
    "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
    "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
    "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
})

_ARABIC_DIACRITICS_RE = re.compile(r"[\u064b-\u065f\u0670\u0640]")
_PUNCT_RE = re.compile(r"[^\w\s\u0600-\u06ff\u200c]", re.UNICODE)
_WHITESPACE_RE = re.compile(r"\s+")
_LATIN_WORD_RE = re.compile(r"[a-zA-Z][a-zA-Z0-9._+-]*")


def normalize_persian_relaxed_v1(text: str) -> str:
    """
    FA-RELAXED-V1 normalization:
    - NFC Unicode normalization
    - Arabic Yeh/Kaf/Alef/Teh-Marbuta unification
    - Diacritics & Tatweel removal
    - Persian/Arabic digits -> ASCII digits
    - ZWNJ normalized to single space for relaxed CER/WER parity (raw metrics retain exact ZWNJ)
    - Lowercases embedded English tokens & strips punctuation
    """
    if not text:
        return ""
    s = unicodedata.normalize("NFC", text)
    s = _ARABIC_DIACRITICS_RE.sub("", s)
    s = s.translate(_PERSIAN_CHAR_MAP)
    s = s.replace("\u200c", " ").replace("\u200f", " ").replace("\u200e", " ")
    s = s.lower()
    s = _PUNCT_RE.sub(" ", s)
    s = _WHITESPACE_RE.sub(" ", s).strip()
    return s


def normalize_english_v1(text: str) -> str:
    if not text:
        return ""
    s = unicodedata.normalize("NFC", text).lower()
    s = s.replace("'", "'").replace("'", "'")
    s = re.sub(r"[^a-z0-9\s']", " ", s)
    s = _WHITESPACE_RE.sub(" ", s).strip()
    return s


def normalize_raw_minimal(text: str) -> str:
    """Minimal whitespace trim only so raw metrics expose all orthographic/ZWNJ/casing differences."""
    if not text:
        return ""
    return _WHITESPACE_RE.sub(" ", unicodedata.normalize("NFC", text)).strip()


def normalize_by_language(text: str, language: str) -> str:
    lang = (language or "").lower()
    if lang.startswith("en"):
        return normalize_english_v1(text)
    return normalize_persian_relaxed_v1(text)


def levenshtein_distance(ref: Sequence[str], hyp: Sequence[str]) -> int:
    """Exact Wagner-Fischer edit distance in O(min(m, n)) memory."""
    m, n = len(ref), len(hyp)
    if m == 0:
        return n
    if n == 0:
        return m
    if m < n:
        ref, hyp = hyp, ref
        m, n = n, m
    prev = list(range(n + 1))
    curr = [0] * (n + 1)
    for i in range(1, m + 1):
        curr[0] = i
        ri = ref[i - 1]
        for j in range(1, n + 1):
            cost = 0 if ri == hyp[j - 1] else 1
            curr[j] = min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
        prev, curr = curr, prev
    return prev[n]


def compute_cer(reference: str, hypothesis: str) -> Tuple[float, int, int]:
    """Returns (cer_ratio, edits, ref_char_count). Ignores leading/trailing whitespace."""
    r_chars = list(reference.strip())
    h_chars = list(hypothesis.strip())
    if not r_chars:
        return (0.0 if not h_chars else 1.0, len(h_chars), 0)
    edits = levenshtein_distance(r_chars, h_chars)
    return (edits / len(r_chars), edits, len(r_chars))


def compute_wer(reference: str, hypothesis: str) -> Tuple[float, int, int]:
    """Returns (wer_ratio, edits, ref_word_count)."""
    r_words = reference.strip().split()
    h_words = hypothesis.strip().split()
    if not r_words:
        return (0.0 if not h_words else 1.0, len(h_words), 0)
    edits = levenshtein_distance(r_words, h_words)
    return (edits / len(r_words), edits, len(r_words))


def compute_latin_token_recall(reference: str, hypothesis: str) -> Optional[float]:
    """Measures how many English/Latin tokens from reference appear in hypothesis (code-switching diagnostic)."""
    ref_tokens = [t.lower() for t in _LATIN_WORD_RE.findall(reference or "")]
    if not ref_tokens:
        return None
    hyp_tokens = [t.lower() for t in _LATIN_WORD_RE.findall(hypothesis or "")]
    hyp_counts: Dict[str, int] = {}
    for t in hyp_tokens:
        hyp_counts[t] = hyp_counts.get(t, 0) + 1
    matched = 0
    for t in ref_tokens:
        if hyp_counts.get(t, 0) > 0:
            matched += 1
            hyp_counts[t] -= 1
    return matched / len(ref_tokens)


@dataclass
class UtteranceEval:
    sample_id: str
    language: str
    duration_sec: float
    reference: str
    hypothesis: str
    inference_sec: float
    raw_cer: float
    norm_cer: float
    raw_wer: float
    norm_wer: float
    raw_char_edits: int
    raw_char_len: int
    norm_char_edits: int
    norm_char_len: int
    raw_word_edits: int
    raw_word_len: int
    norm_word_edits: int
    norm_word_len: int
    latin_recall: Optional[float]


def evaluate_utterance(
    *,
    sample_id: str,
    language: str,
    duration_sec: float,
    reference: str,
    hypothesis: str,
    inference_sec: float,
) -> UtteranceEval:
    raw_ref = normalize_raw_minimal(reference)
    raw_hyp = normalize_raw_minimal(hypothesis)
    norm_ref = normalize_by_language(reference, language)
    norm_hyp = normalize_by_language(hypothesis, language)

    r_cer, r_ce, r_cl = compute_cer(raw_ref, raw_hyp)
    n_cer, n_ce, n_cl = compute_cer(norm_ref, norm_hyp)
    r_wer, r_we, r_wl = compute_wer(raw_ref, raw_hyp)
    n_wer, n_we, n_wl = compute_wer(norm_ref, norm_hyp)

    return UtteranceEval(
        sample_id=sample_id,
        language=language,
        duration_sec=duration_sec,
        reference=reference,
        hypothesis=hypothesis,
        inference_sec=inference_sec,
        raw_cer=r_cer,
        norm_cer=n_cer,
        raw_wer=r_wer,
        norm_wer=n_wer,
        raw_char_edits=r_ce,
        raw_char_len=r_cl,
        norm_char_edits=n_ce,
        norm_char_len=n_cl,
        raw_word_edits=r_we,
        raw_word_len=r_wl,
        norm_word_edits=n_we,
        norm_word_len=n_wl,
        latin_recall=compute_latin_token_recall(reference, hypothesis),
    )


def aggregate_metrics(items: Sequence[UtteranceEval]) -> Dict[str, Optional[float]]:
    if not items:
        return {
            "sample_count": 0,
            "total_audio_sec": 0.0,
            "total_inference_sec": 0.0,
            "rtf": None,
            "raw_cer_pct": None,
            "norm_cer_pct": None,
            "raw_wer_pct": None,
            "norm_wer_pct": None,
            "latin_token_recall_pct": None,
        }
    total_audio = sum(x.duration_sec for x in items)
    total_inf = sum(x.inference_sec for x in items)
    raw_ce = sum(x.raw_char_edits for x in items)
    raw_cl = sum(x.raw_char_len for x in items)
    norm_ce = sum(x.norm_char_edits for x in items)
    norm_cl = sum(x.norm_char_len for x in items)
    raw_we = sum(x.raw_word_edits for x in items)
    raw_wl = sum(x.raw_word_len for x in items)
    norm_we = sum(x.norm_word_edits for x in items)
    norm_wl = sum(x.norm_word_len for x in items)
    latin_vals = [x.latin_recall for x in items if x.latin_recall is not None]

    return {
        "sample_count": len(items),
        "total_audio_sec": round(total_audio, 3),
        "total_inference_sec": round(total_inf, 3),
        "rtf": round(total_inf / total_audio, 4) if total_audio > 0 else None,
        "raw_cer_pct": round(100.0 * raw_ce / raw_cl, 2) if raw_cl > 0 else None,
        "norm_cer_pct": round(100.0 * norm_ce / norm_cl, 2) if norm_cl > 0 else None,
        "raw_wer_pct": round(100.0 * raw_we / raw_wl, 2) if raw_wl > 0 else None,
        "norm_wer_pct": round(100.0 * norm_we / norm_wl, 2) if norm_wl > 0 else None,
        "latin_token_recall_pct": (
            round(100.0 * sum(latin_vals) / len(latin_vals), 2) if latin_vals else None
        ),
    }


def paired_bootstrap_ci(
    baseline_pairs: Sequence[Tuple[int, int]],
    candidate_pairs: Sequence[Tuple[int, int]],
    *,
    iterations: int = 10_000,
    seed: int = 42,
    confidence: float = 0.95,
) -> Dict[str, float]:
    """
    Paired bootstrap confidence interval on (candidate_rate - baseline_rate) in percentage points.
    Negative delta_pp means candidate reduced error rate (improvement).
    Each element is (edits, ref_length) per utterance/cluster.
    """
    n = len(baseline_pairs)
    if n == 0 or n != len(candidate_pairs):
        raise ValueError("baseline_pairs and candidate_pairs must be non-empty and equal length")

    rng = random.Random(seed)
    deltas: List[float] = []
    for _ in range(iterations):
        b_ed = b_len = c_ed = c_len = 0
        for _ in range(n):
            idx = rng.randrange(n)
            be, bl = baseline_pairs[idx]
            ce, cl = candidate_pairs[idx]
            b_ed += be
            b_len += bl
            c_ed += ce
            c_len += cl
        b_rate = (100.0 * b_ed / b_len) if b_len > 0 else 0.0
        c_rate = (100.0 * c_ed / c_len) if c_len > 0 else 0.0
        deltas.append(c_rate - b_rate)

    deltas.sort()
    alpha = (1.0 - confidence) / 2.0
    lo_idx = max(0, int(math.floor(alpha * iterations)))
    hi_idx = min(iterations - 1, int(math.ceil((1.0 - alpha) * iterations)) - 1)
    obs_b = 100.0 * sum(x[0] for x in baseline_pairs) / max(1, sum(x[1] for x in baseline_pairs))
    obs_c = 100.0 * sum(x[0] for x in candidate_pairs) / max(1, sum(x[1] for x in candidate_pairs))
    return {
        "baseline_pct": round(obs_b, 3),
        "candidate_pct": round(obs_c, 3),
        "delta_pp": round(obs_c - obs_b, 3),
        "ci_low_pp": round(deltas[lo_idx], 3),
        "ci_high_pp": round(deltas[hi_idx], 3),
        "iterations": iterations,
        "seed": seed,
    }


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()
