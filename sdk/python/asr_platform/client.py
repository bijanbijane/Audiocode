"""Official Python SDK for Independent Persian-English ASR Platform v1.

Uploads genuine binary audio (`bytes`, `bytearray`, file-like object, or file path) to
`POST /v1/audio/transcriptions` with JSON options encoded in the `X-ASR-Options` header.
Never sends client-supplied `audio_duration_ms` or `raw_text_hint`, and never retries
non-seekable one-shot streams.
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import random
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, BinaryIO, Dict, Optional, Union


@dataclass
class ASRApiError(Exception):
    status: int
    code: str
    message: str
    request_id: str
    retryable: bool

    def __str__(self) -> str:
        return f"[{self.code}] {self.message} (status={self.status}, request_id={self.request_id})"


AudioInput = Union[bytes, bytearray, memoryview, BinaryIO, os.PathLike[str], str]


class _TranscriptionsResource:
    def __init__(self, client: "ASRClient") -> None:
        self._client = client

    def create(
        self,
        *,
        audio: AudioInput,
        content_type: str,
        model: str = "asr-fa-en-v1",
        language: str = "auto",
        timestamps: bool = False,
        diarization: bool = False,
        domain_profile: str = "technology",
        execution_mode: str = "batch",
        region_id: Optional[str] = None,
        metadata: Optional[Dict[str, str]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not content_type or not content_type.strip():
            raise ValueError("content_type is required (e.g., 'audio/wav', 'audio/ogg', 'audio/mpeg').")

        options_payload: Dict[str, Any] = {
            "model": model,
            "language": language,
            "timestamps": timestamps,
            "diarization": diarization,
            "domain_profile": domain_profile,
            "execution_mode": execution_mode,
        }
        if region_id is not None:
            options_payload["region_id"] = region_id
        if metadata is not None:
            options_payload["metadata"] = metadata

        return self._client._request_binary_upload(
            path="/v1/audio/transcriptions",
            audio=audio,
            content_type=content_type.strip(),
            options_payload=options_payload,
            idempotency_key=idempotency_key,
        )

    def retrieve(self, transcription_id: str) -> Dict[str, Any]:
        return self._client._request("GET", f"/v1/audio/transcriptions/{transcription_id}")

    def estimate(self, *, duration_seconds: int, model: str = "asr-fa-en-v1") -> Dict[str, Any]:
        return self._client._request(
            "POST",
            "/v1/audio/estimates",
            {"model": model, "duration_seconds": duration_seconds},
        )


class _AudioNamespace:
    def __init__(self, client: "ASRClient") -> None:
        self.transcriptions = _TranscriptionsResource(client)
        self._client = client

    def create_streaming_session(self, *, model: str = "asr-fa-en-v1", language: str = "auto") -> Dict[str, Any]:
        return self._client._request(
            "POST",
            "/v1/audio/streaming-sessions",
            {"model": model, "language": language, "sample_rate": 16000, "channels": 1},
        )


class ASRClient:
    """Synchronous zero-dependency Python client using stdlib urllib with safe retries."""

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = "http://localhost:3000",
        timeout_seconds: float = 30.0,
        max_retries: int = 2,
    ) -> None:
        if not api_key or not api_key.strip():
            raise ValueError("ASRClient requires a valid api_key.")
        self.api_key = api_key.strip()
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self.max_retries = max_retries
        self.audio = _AudioNamespace(self)

    def _prepare_audio_bytes(self, audio: AudioInput) -> tuple[bytes, bool]:
        if isinstance(audio, (bytes, bytearray, memoryview)):
            return bytes(audio), True
        if isinstance(audio, (str, os.PathLike)):
            with open(audio, "rb") as fh:
                return fh.read(), True
        if hasattr(audio, "read"):
            seekable = bool(getattr(audio, "seekable", lambda: False)())
            data = audio.read()
            if not isinstance(data, (bytes, bytearray)):
                raise TypeError("Audio file-like object must open in binary mode and return bytes.")
            return bytes(data), seekable
        raise TypeError("audio must be bytes, bytearray, path, or binary file-like object.")

    def _request_binary_upload(
        self,
        *,
        path: str,
        audio: AudioInput,
        content_type: str,
        options_payload: Dict[str, Any],
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        raw_bytes, replayable = self._prepare_audio_bytes(audio)
        allowed_retries = self.max_retries if replayable else 0

        attempt = 0
        while True:
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": content_type,
                "X-ASR-Options": json.dumps(options_payload, separators=(",", ":")),
                "Content-Length": str(len(raw_bytes)),
            }
            if idempotency_key:
                headers["Idempotency-Key"] = idempotency_key

            req = urllib.request.Request(
                f"{self.base_url}{path}",
                data=raw_bytes,
                headers=headers,
                method="POST",
            )

            try:
                with urllib.request.urlopen(req, timeout=self.timeout_seconds) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                raw = exc.read().decode("utf-8", errors="replace")
                parsed = json.loads(raw) if raw.startswith("{") else {}
                err_obj = parsed.get("error", {})
                api_err = ASRApiError(
                    status=exc.code,
                    code=str(err_obj.get("code", "HTTP_ERROR")),
                    message=str(err_obj.get("message", exc.reason)),
                    request_id=str(err_obj.get("request_id", "unknown")),
                    retryable=bool(err_obj.get("retryable", False)) and exc.code in (429, 502, 503, 504),
                )
                if not api_err.retryable or attempt >= allowed_retries:
                    raise api_err from exc
            except urllib.error.URLError as exc:
                if attempt >= allowed_retries:
                    raise exc

            attempt += 1
            time.sleep(min(4.0, 0.25 * (2 ** attempt) + random.uniform(0.0, 0.15)))

    def _request(
        self,
        method: str,
        path: str,
        payload: Optional[Dict[str, Any]] = None,
        *,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        attempt = 0
        while True:
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            }
            if idempotency_key:
                headers["Idempotency-Key"] = idempotency_key

            data = json.dumps(payload).encode("utf-8") if payload is not None else None
            req = urllib.request.Request(f"{self.base_url}{path}", data=data, headers=headers, method=method)

            try:
                with urllib.request.urlopen(req, timeout=self.timeout_seconds) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                raw = exc.read().decode("utf-8", errors="replace")
                parsed = json.loads(raw) if raw.startswith("{") else {}
                err_obj = parsed.get("error", {})
                api_err = ASRApiError(
                    status=exc.code,
                    code=str(err_obj.get("code", "HTTP_ERROR")),
                    message=str(err_obj.get("message", exc.reason)),
                    request_id=str(err_obj.get("request_id", "unknown")),
                    retryable=bool(err_obj.get("retryable", False)) and exc.code in (429, 502, 503, 504),
                )
                if not api_err.retryable or attempt >= self.max_retries:
                    raise api_err from exc
            except urllib.error.URLError as exc:
                if attempt >= self.max_retries:
                    raise exc

            attempt += 1
            time.sleep(min(4.0, 0.25 * (2 ** attempt) + random.uniform(0.0, 0.15)))


def verify_webhook_signature(*, secret: str, signature_header: str, raw_payload: str, tolerance_seconds: int = 300) -> bool:
    parts = dict(kv.split("=", 1) for kv in signature_header.split(",") if "=" in kv)
    if "t" not in parts or "v1" not in parts:
        return False
    ts = int(parts["t"])
    if abs(int(time.time()) - ts) > tolerance_seconds:
        return False
    expected = hmac.new(secret.encode("utf-8"), f"{ts}.{raw_payload}".encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts["v1"])
