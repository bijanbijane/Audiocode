#!/usr/bin/env python3
"""
AVAPARDAZ — PHASE-02 Persian Frame-Level CTC Viterbi Forced Aligner (RECOVERY-007)

Implements true frame-level CTC Viterbi forced alignment directly on
`Reza2kn/Shenava-Rizeh v1.0 INT8` (`model.int8.onnx`, Apache-2.0) via `onnxruntime`,
requiring ZERO additional model weights and ZERO additional RAM beyond the ASR model.

Capabilities:
  1. Exact NeMo-compatible 80-bin log-mel spectrogram frontend (16 kHz, 25 ms Hann window,
     10 ms hop, 512-pt FFT, Slaney mel bank, pre-emphasis 0.97).
  2. Greedy CTC decoding (for Track B recognition-driven alignment & parity verification).
  3. True monotonic log-domain CTC Viterbi Forced Alignment emitting BOTH word onset
     (`start`) and word offset (`end`) for any target Persian transcript (Track A reference
     or Track B ASR hypothesis), strictly preserving repeated identical words as separate
     sequential events.
  4. Optional acoustic energy-envelope refinement to tighten silence margins at utterance
     edges without collapsing intervals.
  5. Direct Praat `.TextGrid` export carrying explicit `UNVERIFIED_MACHINE_DRAFT` provenance.
"""

from __future__ import annotations

import math
import re
import time
import unicodedata
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import onnxruntime as ort

DEFAULT_SHENAVA_DIR = Path(
    "/root/.avapardaz/models/sherpa-onnx-nemo-ctc-fa-shenava-rizeh-v1.0-non-streaming-int8-2026-06-26"
)
SAMPLE_RATE = 16000
N_FFT = 512
WIN_LENGTH = 400   # 25 ms at 16 kHz
HOP_LENGTH = 160   # 10 ms at 16 kHz
N_MELS = 80
PREEMPH = 0.97
LOG_GUARD = 2.0 ** -24
SUBSAMPLING_FACTOR = 8
FRAME_DURATION_SEC = (HOP_LENGTH * SUBSAMPLING_FACTOR) / float(SAMPLE_RATE)  # 0.08 s (80 ms)


@dataclass(frozen=True)
class AlignedWord:
    word: str
    start: float
    end: float
    confidence: float
    n_tokens: int


def _hz_to_mel_slaney(hz: np.ndarray) -> np.ndarray:
    f_min = 0.0
    f_sp = 200.0 / 3.0
    min_log_hz = 1000.0
    min_log_mel = (min_log_hz - f_min) / f_sp
    logstep = np.log(6.4) / 27.0
    mels = (hz - f_min) / f_sp
    log_region = hz >= min_log_hz
    mels = np.where(log_region, min_log_mel + np.log(np.maximum(hz, 1e-10) / min_log_hz) / logstep, mels)
    return mels


def _mel_to_hz_slaney(mels: np.ndarray) -> np.ndarray:
    f_min = 0.0
    f_sp = 200.0 / 3.0
    min_log_hz = 1000.0
    min_log_mel = (min_log_hz - f_min) / f_sp
    logstep = np.log(6.4) / 27.0
    freqs = f_min + f_sp * mels
    log_region = mels >= min_log_mel
    freqs = np.where(log_region, min_log_hz * np.exp(logstep * (mels - min_log_mel)), freqs)
    return freqs


def build_nemo_mel_filterbank(
    sr: int = SAMPLE_RATE,
    n_fft: int = N_FFT,
    n_mels: int = N_MELS,
    fmin: float = 0.0,
    fmax: Optional[float] = None,
) -> np.ndarray:
    """Slaney-normalized mel filterbank matching librosa / NeMo FilterbankFeatures."""
    if fmax is None:
        fmax = sr / 2.0
    n_freqs = 1 + n_fft // 2
    fft_freqs = np.linspace(0.0, sr / 2.0, n_freqs, dtype=np.float64)
    mel_min = _hz_to_mel_slaney(np.array([fmin]))[0]
    mel_max = _hz_to_mel_slaney(np.array([fmax]))[0]
    mel_pts = np.linspace(mel_min, mel_max, n_mels + 2, dtype=np.float64)
    hz_pts = _mel_to_hz_slaney(mel_pts)

    fb = np.zeros((n_mels, n_freqs), dtype=np.float64)
    for i in range(n_mels):
        left, center, right = hz_pts[i], hz_pts[i + 1], hz_pts[i + 2]
        lower = (fft_freqs - left) / max(center - left, 1e-12)
        upper = (right - fft_freqs) / max(right - center, 1e-12)
        fb[i] = np.maximum(0.0, np.minimum(lower, upper))
        enorm = 2.0 / max(right - left, 1e-12)
        fb[i] *= enorm
    return fb.astype(np.float32)


def load_wav_mono_16k(wav_path: str | Path) -> Tuple[np.ndarray, float]:
    with wave.open(str(wav_path), "rb") as wf:
        sr = wf.getframerate()
        ch = wf.getnchannels()
        sw = wf.getsampwidth()
        raw = wf.readframes(wf.getnframes())
    if sw != 2:
        raise ValueError(f"Expected 16-bit PCM WAV, got sampwidth={sw} in {wav_path}")
    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        pcm = pcm.reshape(-1, ch).mean(axis=1)
    if sr != SAMPLE_RATE:
        # Linear resample fallback if needed
        n_out = int(round(len(pcm) * SAMPLE_RATE / float(sr)))
        x_old = np.linspace(0.0, 1.0, len(pcm), endpoint=False)
        x_new = np.linspace(0.0, 1.0, n_out, endpoint=False)
        pcm = np.interp(x_new, x_old, pcm).astype(np.float32)
    duration = len(pcm) / float(SAMPLE_RATE)
    return pcm, duration


def extract_nemo_log_mel(
    wav: np.ndarray,
    mel_fb: np.ndarray,
    normalize_per_feature: bool = False,
) -> np.ndarray:
    """
    Computes NeMo-compatible [1, 80, T] float32 log-mel spectrogram.
    Matches sherpa-onnx NeMo CTC frontend (hann window, center pad, preemph 0.97,
    power spectrum, Slaney mel bank, log(x + 2^-24), optional per-feature norm).
    """
    x = wav.astype(np.float32)
    if len(x) < WIN_LENGTH:
        x = np.pad(x, (0, WIN_LENGTH - len(x)))

    # Pre-emphasis
    y = np.empty_like(x)
    y[0] = x[0]
    y[1:] = x[1:] - PREEMPH * x[:-1]

    # Center reflect/zero padding matching torch.stft(..., center=True)
    pad = N_FFT // 2
    y_pad = np.pad(y, (pad, pad), mode="constant")

    n_frames = 1 + (len(y_pad) - N_FFT) // HOP_LENGTH
    if n_frames <= 0:
        n_frames = 1
        y_pad = np.pad(y_pad, (0, N_FFT - len(y_pad)))

    # Framing
    strides = (y_pad.strides[0] * HOP_LENGTH, y_pad.strides[0])
    frames = np.lib.stride_tricks.as_strided(
        y_pad, shape=(n_frames, N_FFT), strides=strides
    ).copy()

    # Hann window centered in N_FFT
    win = np.zeros(N_FFT, dtype=np.float32)
    start_w = (N_FFT - WIN_LENGTH) // 2
    # Periodic Hann window matching torch.hann_window(WIN_LENGTH, periodic=True)
    n_idx = np.arange(WIN_LENGTH, dtype=np.float32)
    win[start_w : start_w + WIN_LENGTH] = 0.5 - 0.5 * np.cos(2.0 * np.pi * n_idx / float(WIN_LENGTH))
    frames *= win[None, :]

    spec = np.fft.rfft(frames, n=N_FFT, axis=1)
    power = (spec.real ** 2 + spec.imag ** 2).astype(np.float32)
    mel = np.matmul(mel_fb, power.T)  # [80, T]
    log_mel = np.log(np.maximum(mel, 0.0) + LOG_GUARD).astype(np.float32)

    if normalize_per_feature and log_mel.shape[1] > 1:
        mean = log_mel.mean(axis=1, keepdims=True)
        std = log_mel.std(axis=1, ddof=1, keepdims=True) + 1e-5
        log_mel = (log_mel - mean) / std

    return log_mel[None, :, :]  # [1, 80, T]


def _normalize_persian_for_bpe(text: str) -> str:
    s = unicodedata.normalize("NFKC", text.strip())
    s = (
        s.replace("\u064a", "\u06cc")
        .replace("\u0649", "\u06cc")
        .replace("\u0643", "\u06a9")
        .replace("\u0629", "\u0647")
        .replace("\u0640", "")
    )
    s = re.sub(r"[\u064B-\u065F\u0670]", "", s)
    return s


class ShenavaCTCAligner:
    """
    True Frame-Level CTC Viterbi Forced Aligner backed directly by
    `Reza2kn/Shenava-Rizeh v1.0 INT8` (`model.int8.onnx`, Apache-2.0).
    """

    def __init__(
        self,
        model_dir: str | Path = DEFAULT_SHENAVA_DIR,
        num_threads: int = 3,
        normalize_per_feature: bool = False,
    ) -> None:
        self.model_dir = Path(model_dir)
        self.model_path = self.model_dir / "model.int8.onnx"
        self.tokens_path = self.model_dir / "tokens.txt"
        self.normalize_per_feature = normalize_per_feature

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = num_threads
        opts.inter_op_num_threads = 1
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(
            str(self.model_path), sess_options=opts, providers=["CPUExecutionProvider"]
        )
        meta = self.session.get_modelmeta().custom_metadata_map
        self.subsampling_factor = int(meta.get("subsampling_factor", SUBSAMPLING_FACTOR))
        self.frame_sec = (HOP_LENGTH * self.subsampling_factor) / float(SAMPLE_RATE)

        self.id_to_tok: Dict[int, str] = {}
        self.tok_to_id: Dict[str, int] = {}
        self.blank_id: int = 1024
        for line in self.tokens_path.read_text(encoding="utf-8").splitlines():
            parts = line.rsplit(" ", 1)
            if len(parts) != 2:
                continue
            tok, idx_s = parts[0], parts[1]
            idx = int(idx_s)
            self.id_to_tok[idx] = tok
            self.tok_to_id[tok] = idx
            if tok == "<blk>":
                self.blank_id = idx

        self.unk_id = self.tok_to_id.get("<unk>", 0)
        self.max_tok_len = max((len(t) for t in self.tok_to_id if not t.startswith("<")), default=1)
        self.mel_fb = build_nemo_mel_filterbank()

    def infer_logprobs(self, wav: np.ndarray) -> np.ndarray:
        """Runs ONNX inference and returns [T_out, V] float32 log-probabilities."""
        feats = extract_nemo_log_mel(
            wav, self.mel_fb, normalize_per_feature=self.normalize_per_feature
        )
        lengths = np.array([feats.shape[2]], dtype=np.int64)
        outputs = self.session.run(None, {"audio_signal": feats, "length": lengths})
        logprobs = outputs[0][0]  # [T_out, V]
        return logprobs

    def greedy_decode(self, logprobs: np.ndarray) -> str:
        """Greedy CTC decoding from [T_out, V] log-probabilities."""
        ids = np.argmax(logprobs, axis=-1).tolist()
        pieces: List[str] = []
        prev = -1
        for tid in ids:
            if tid != prev and tid != self.blank_id:
                tok = self.id_to_tok.get(tid, "")
                if not tok.startswith("<"):
                    pieces.append(tok)
            prev = tid
        text = "".join(pieces).replace("\u2581", " ").strip()
        return re.sub(r"\s+", " ", text)

    def encode_word_to_bpe(self, word: str) -> List[int]:
        """Longest-match SentencePiece BPE encoding matching tokens.txt vocabulary."""
        clean = _normalize_persian_for_bpe(word)
        if not clean:
            return []
        s = "\u2581" + clean
        out: List[int] = []
        pos = 0
        n = len(s)
        while pos < n:
            matched_id: Optional[int] = None
            matched_len = 0
            max_l = min(self.max_tok_len, n - pos)
            for l in range(max_l, 0, -1):
                cand = s[pos : pos + l]
                if cand in self.tok_to_id:
                    matched_id = self.tok_to_id[cand]
                    matched_len = l
                    break
            if matched_id is not None:
                out.append(matched_id)
                pos += matched_len
            else:
                # Skip unrepresentable punctuation or fall back to unk only if word empty
                pos += 1
        if not out:
            out.append(self.unk_id)
        return out

    def encode_transcript_words(self, text: str) -> Tuple[List[str], List[int], List[Tuple[int, int]]]:
        """
        Tokenizes transcript word-by-word, preserving repeated words as independent spans.
        Returns (words, flat_token_ids, word_token_spans[(start_idx, end_idx_excl)]).
        """
        raw_words = [w for w in re.split(r"\s+", text.strip()) if w]
        words: List[str] = []
        flat_ids: List[int] = []
        spans: List[Tuple[int, int]] = []
        for w in raw_words:
            # Keep words that contain at least one letter or digit
            if not re.search(r"[\w\u0600-\u06FF]", w):
                continue
            tids = self.encode_word_to_bpe(w)
            if not tids:
                continue
            start_i = len(flat_ids)
            flat_ids.extend(tids)
            spans.append((start_i, len(flat_ids)))
            words.append(w)
        return words, flat_ids, spans

    def viterbi_align_tokens(
        self,
        logprobs: np.ndarray,
        token_ids: Sequence[int],
    ) -> List[Tuple[int, int, float]]:
        """
        Exact monotonic log-domain CTC Viterbi forced alignment.
        Expanded state sequence: [blk, t0, blk, t1, blk, ..., t_{L-1}, blk] (length S = 2L + 1).
        Returns per-token (start_frame, end_frame_exclusive, mean_logprob).
        """
        T, V = logprobs.shape
        L = len(token_ids)
        if L == 0 or T == 0:
            return []

        # If target token sequence exceeds available frames (rare ultra-short clip),
        # fall back to proportional monotonic allocation so we never crash.
        if L > T:
            step = T / float(L)
            return [
                (
                    min(T - 1, int(math.floor(i * step))),
                    max(min(T, int(math.ceil((i + 1) * step))), min(T - 1, int(math.floor(i * step))) + 1),
                    float(logprobs[min(T - 1, int(math.floor(i * step))), token_ids[i]]),
                )
                for i in range(L)
            ]

        S = 2 * L + 1
        states = np.full(S, self.blank_id, dtype=np.int32)
        for i, tid in enumerate(token_ids):
            states[2 * i + 1] = tid

        neg_inf = -1e30
        dp = np.full((T, S), neg_inf, dtype=np.float64)
        backptr = np.zeros((T, S), dtype=np.int8)  # 0: stay(s), 1: from s-1, 2: from s-2

        dp[0, 0] = float(logprobs[0, self.blank_id])
        dp[0, 1] = float(logprobs[0, states[1]])

        # Precompute whether skip (s-2 -> s) is allowed: only for non-blank s>=3 where states[s] != states[s-2]
        can_skip = np.zeros(S, dtype=bool)
        for s in range(3, S, 2):
            if states[s] != states[s - 2]:
                can_skip[s] = True

        s_idx = np.arange(S)
        for t in range(1, T):
            emit = logprobs[t, states]  # [S]
            prev = dp[t - 1]

            # Option 0: stay at s
            best = prev.copy()
            bp = np.zeros(S, dtype=np.int8)

            # Option 1: transition from s-1
            cand1 = np.full(S, neg_inf, dtype=np.float64)
            cand1[1:] = prev[:-1]
            mask1 = cand1 > best
            best = np.where(mask1, cand1, best)
            bp = np.where(mask1, 1, bp)

            # Option 2: skip blank from s-2 (only where can_skip[s] is True)
            cand2 = np.full(S, neg_inf, dtype=np.float64)
            cand2[2:] = np.where(can_skip[2:], prev[:-2], neg_inf)
            mask2 = cand2 > best
            best = np.where(mask2, cand2, best)
            bp = np.where(mask2, 2, bp)

            dp[t] = best + emit
            backptr[t] = bp

        # Terminate at either final blank (S-1) or final token (S-2)
        cur_s = S - 1 if dp[T - 1, S - 1] >= dp[T - 1, S - 2] else S - 2
        if dp[T - 1, cur_s] <= neg_inf / 2.0:
            # Degenerate fallback: pick highest reachable state
            cur_s = int(np.argmax(dp[T - 1]))

        path = np.empty(T, dtype=np.int32)
        for t in range(T - 1, -1, -1):
            path[t] = cur_s
            step = int(backptr[t, cur_s]) if t > 0 else 0
            cur_s = max(0, cur_s - step)

        # Extract per-token frame span [start_frame, end_frame_excl]
        token_spans: List[Tuple[int, int, float]] = []
        for i in range(L):
            state_id = 2 * i + 1
            frames = np.where(path == state_id)[0]
            if len(frames) > 0:
                f_start = int(frames[0])
                f_end = int(frames[-1]) + 1
                score = float(np.mean(logprobs[frames, token_ids[i]]))
            else:
                # Interpolate strictly monotonically from neighbor if a token got skipped
                prev_end = token_spans[-1][1] if token_spans else 0
                f_start = min(T - 1, prev_end)
                f_end = min(T, f_start + 1)
                score = float(logprobs[f_start, token_ids[i]])
            token_spans.append((f_start, f_end, score))
        return token_spans

    def _refine_edges_with_energy(
        self,
        wav: np.ndarray,
        words: List[AlignedWord],
        duration_sec: float,
        energy_thr_db: float = -35.0,
    ) -> List[AlignedWord]:
        """Tightens first-word onset and last-word offset against acoustic silence margin."""
        if not words or len(wav) < 320:
            return words
        win = int(0.02 * SAMPLE_RATE)  # 20 ms frame
        n_win = len(wav) // win
        if n_win == 0:
            return words
        x = wav[: n_win * win].reshape(n_win, win)
        e = np.mean(x ** 2, axis=1) + 1e-10
        db = 10.0 * np.log10(e)
        peak_db = float(np.max(db))
        speech_frames = np.where(db >= peak_db + energy_thr_db)[0]
        if len(speech_frames) == 0:
            return words

        speech_start = float(speech_frames[0]) * 0.02
        speech_end = min(duration_sec, float(speech_frames[-1] + 1) * 0.02)

        refined = list(words)
        # Clamp first word start if it precedes acoustic speech onset, preserving min duration 20ms
        first = refined[0]
        new_start = max(first.start, min(speech_start, first.end - 0.02))
        if new_start < first.end:
            refined[0] = AlignedWord(first.word, round(new_start, 3), first.end, first.confidence, first.n_tokens)

        # Clamp last word end if it trails into silence, preserving min duration 20ms
        last = refined[-1]
        new_end = min(last.end, max(speech_end, last.start + 0.02))
        if new_end > last.start:
            refined[-1] = AlignedWord(last.word, last.start, round(new_end, 3), last.confidence, last.n_tokens)
        return refined

    def align_file(
        self,
        wav_path: str | Path,
        transcript: Optional[str] = None,
        energy_refine: bool = True,
    ) -> Dict[str, Any]:
        """
        Runs ONNX forward pass + CTC Viterbi forced alignment.
        - If `transcript` is provided: Track A (Reference Transcript Alignment).
        - If `transcript` is None: Track B (Recognition-Driven Alignment using greedy CTC decode).
        """
        t0 = time.perf_counter()
        wav, duration_sec = load_wav_mono_16k(wav_path)
        logprobs = self.infer_logprobs(wav)
        decoded_text = self.greedy_decode(logprobs)

        target_text = decoded_text if transcript is None else transcript
        words, flat_ids, word_spans = self.encode_transcript_words(target_text)
        tok_frames = self.viterbi_align_tokens(logprobs, flat_ids)

        aligned: List[AlignedWord] = []
        n_frames = logprobs.shape[0]
        # Effective per-frame duration scales smoothly to exact clip duration
        eff_frame_sec = duration_sec / float(max(n_frames, 1))
        prev_end = 0.0
        for w_text, (ts, te) in zip(words, word_spans):
            f0 = tok_frames[ts][0]
            f1 = tok_frames[te - 1][1]
            # Extend token offset slightly to account for CTC peak emission lag (~half frame)
            start_s = max(prev_end, min(duration_sec, f0 * eff_frame_sec))
            end_s = min(duration_sec, max(start_s + 0.02, f1 * eff_frame_sec))
            if end_s > duration_sec:
                end_s = duration_sec
                start_s = max(0.0, min(start_s, end_s - 0.01))
            conf = float(math.exp(np.mean([tok_frames[k][2] for k in range(ts, te)])))
            aligned.append(
                AlignedWord(
                    word=w_text,
                    start=round(start_s, 3),
                    end=round(end_s, 3),
                    confidence=round(conf, 4),
                    n_tokens=(te - ts),
                )
            )
            prev_end = end_s

        if energy_refine and aligned:
            aligned = self._refine_edges_with_energy(wav, aligned, duration_sec=duration_sec)

        # Final monotonicity & boundary safety pass
        safe_words: List[AlignedWord] = []
        cursor = 0.0
        for aw in aligned:
            s = max(cursor, min(aw.start, duration_sec))
            e = min(duration_sec, max(s + 0.01, aw.end))
            if e <= s:
                continue
            safe_words.append(AlignedWord(aw.word, round(s, 3), round(e, 3), aw.confidence, aw.n_tokens))
            cursor = e

        elapsed = time.perf_counter() - t0
        return {
            "wav_path": str(wav_path),
            "duration_sec": round(duration_sec, 4),
            "elapsed_sec": round(elapsed, 4),
            "rtf": round(elapsed / max(duration_sec, 1e-6), 4),
            "frame_stride_ms": round(eff_frame_sec * 1000.0, 2),
            "decoded_text": decoded_text,
            "aligned_text": target_text,
            "track": "TRACK_B_ASR_HYPOTHESIS" if transcript is None else "TRACK_A_REFERENCE",
            "words": [
                {
                    "word": w.word,
                    "start": w.start,
                    "end": w.end,
                    "confidence": w.confidence,
                    "n_tokens": w.n_tokens,
                }
                for w in safe_words
            ],
        }


def aligned_words_to_textgrid(
    words: Sequence[Dict[str, Any]],
    audio_duration_sec: float,
    speaker_label: str = "SPEAKER_01",
    language_label: str = "fa",
    provenance_tag: str = "UNVERIFIED_MACHINE_DRAFT",
) -> str:
    """
    Exports aligned words to AvaPardaz 6-tier Praat ooTextFile TextGrid format
    compatible with `datasets/phase02/validate_textgrid.py`, explicitly stamping
    `annotation_uncertainty` with `UNVERIFIED_MACHINE_DRAFT` so machine drafts
    can never be mistaken for human-verified ground truth.
    """
    dur = round(float(audio_duration_sec), 4)

    def _tile_intervals(items: List[Tuple[float, float, str]]) -> List[Tuple[float, float, str]]:
        tiled: List[Tuple[float, float, str]] = []
        cur = 0.0
        for s, e, txt in items:
            s = max(cur, min(float(s), dur))
            e = max(s, min(float(e), dur))
            if s > cur + 1e-4:
                tiled.append((round(cur, 4), round(s, 4), ""))
            if e > s + 1e-4:
                tiled.append((round(s, 4), round(e, 4), txt))
                cur = e
        if cur < dur - 1e-4:
            tiled.append((round(cur, 4), dur, ""))
        if not tiled:
            tiled.append((0.0, dur, ""))
        return tiled

    word_items = _tile_intervals([(w["start"], w["end"], str(w["word"])) for w in words])
    tiers = [
        ("speaker", [(0.0, dur, speaker_label)]),
        ("words", word_items),
        ("language", [(0.0, dur, language_label)]),
        ("disfluency_events", [(0.0, dur, "")]),
        ("repetition_events", [(0.0, dur, "")]),
        ("annotation_uncertainty", [(0.0, dur, provenance_tag)]),
    ]

    lines = [
        'File type = "ooTextFile"',
        'Object class = "TextGrid"',
        "",
        "xmin = 0",
        f"xmax = {dur}",
        "tiers? <exists>",
        f"size = {len(tiers)}",
        "item []:",
    ]
    for tidx, (tname, ivs) in enumerate(tiers, start=1):
        lines.append(f"    item [{tidx}]:")
        lines.append('        class = "IntervalTier"')
        lines.append(f'        name = "{tname}"')
        lines.append("        xmin = 0")
        lines.append(f"        xmax = {dur}")
        lines.append(f"        intervals: size = {len(ivs)}")
        for iidx, (xmin, xmax, txt) in enumerate(ivs, start=1):
            esc = txt.replace('"', '""')
            lines.append(f"        intervals [{iidx}]:")
            lines.append(f"            xmin = {xmin}")
            lines.append(f"            xmax = {xmax}")
            lines.append(f'            text = "{esc}"')
    return "\n".join(lines) + "\n"
