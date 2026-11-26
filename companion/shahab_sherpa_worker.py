#!/usr/bin/env python3
"""Persistent offline Sherpa-ONNX worker for SHAHAB Engine 01.

Protocol: one JSON request per stdin line; one JSON response per stdout line.
The recognizer and ONNX weights are loaded exactly once for the lifetime of this process.
Only a bounded, already chunked canonical WAV is read for each request.
"""

from __future__ import annotations

import argparse
import array
import json
import os
import sys
import wave
from typing import Any


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def read_canonical_pcm16_wav(path: str, max_duration_sec: float) -> tuple[int, array.array]:
    resolved = os.path.realpath(path)
    if not os.path.isfile(resolved):
        raise FileNotFoundError("AUDIO_CHUNK_NOT_FOUND")

    with wave.open(resolved, "rb") as wav:
        channels = wav.getnchannels()
        sample_rate = wav.getframerate()
        sample_width = wav.getsampwidth()
        frame_count = wav.getnframes()
        compression = wav.getcomptype()

        if channels != 1 or sample_rate != 16_000 or sample_width != 2 or compression != "NONE":
            raise ValueError("UNSUPPORTED_CANONICAL_WAV: expected mono 16kHz PCM16 RIFF WAV")
        if frame_count <= 0 or frame_count > int(max_duration_sec * sample_rate):
            raise ValueError("AUDIO_CHUNK_DURATION_OUT_OF_RANGE")

        raw = wav.readframes(frame_count)
        if len(raw) != frame_count * 2:
            raise ValueError("TRUNCATED_CANONICAL_WAV")

    samples = array.array("h")
    samples.frombytes(raw)
    if sys.byteorder != "little":
        samples.byteswap()

    # sherpa-onnx's Python binding accepts a Sequence[float]. array('f') avoids
    # the multi-megabyte Python list that list comprehensions would allocate.
    waveform = array.array("f", (sample / 32768.0 for sample in samples))
    return sample_rate, waveform


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--tokens", required=True)
    parser.add_argument("--num-threads", type=int, default=4)
    parser.add_argument("--provider", default="cpu")
    parser.add_argument("--max-chunk-sec", type=float, default=35.0)
    args = parser.parse_args()

    try:
        import sherpa_onnx

        if not os.path.isfile(args.model) or not os.path.isfile(args.tokens):
            raise FileNotFoundError("VERIFIED_MODEL_FILES_NOT_FOUND")

        recognizer = sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
            model=args.model,
            tokens=args.tokens,
            num_threads=max(1, min(8, args.num_threads)),
            sample_rate=16_000,
            feature_dim=80,
            decoding_method="greedy_search",
            debug=False,
            provider=args.provider,
        )
        emit({
            "type": "ready",
            "ok": True,
            "runtime": "sherpa-onnx-python-persistent",
            "runtimeVersion": getattr(sherpa_onnx, "__version__", "unknown"),
        })
    except Exception as exc:  # initialization failures must be explicit to the Node host
        emit({"type": "ready", "ok": False, "error": str(exc)[:1000]})
        return 2

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id = ""
        try:
            request = json.loads(line)
            request_id = str(request.get("requestId", ""))
            if request.get("type") == "shutdown":
                emit({"type": "shutdown", "ok": True, "requestId": request_id})
                return 0
            if request.get("type") != "transcribe" or not request_id:
                raise ValueError("INVALID_WORKER_REQUEST")

            sample_rate, waveform = read_canonical_pcm16_wav(
                str(request.get("wavPath", "")), args.max_chunk_sec
            )
            stream = recognizer.create_stream()
            stream.accept_waveform(sample_rate, waveform)
            recognizer.decode_stream(stream)
            result = stream.result

            tokens = list(getattr(result, "tokens", ()) or ())
            timestamps = list(getattr(result, "timestamps", ()) or ())
            durations = list(getattr(result, "durations", ()) or ())
            ys_log_probs = list(getattr(result, "ys_log_probs", ()) or ())

            emit({
                "type": "result",
                "requestId": request_id,
                "ok": True,
                "lang": str(getattr(result, "lang", "") or ""),
                "text": str(getattr(result, "text", "") or ""),
                "tokens": [str(token) for token in tokens],
                "timestamps": [float(value) for value in timestamps],
                "durations": [float(value) for value in durations],
                "ysLogProbs": [float(value) for value in ys_log_probs],
            })
        except Exception as exc:
            emit({
                "type": "result",
                "requestId": str(locals().get("request_id", "")),
                "ok": False,
                "error": str(exc)[:1000],
            })

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
