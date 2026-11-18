# SECURITY, PRIVACY & SECRET REDACTION POLICY — PHASE 3 & PHASE 5

**Document Version:** `1.0.0-phase3-5`

---

## 1. Secret Management & Redaction (`sanitizeSecretsFromText`)
- API keys (`ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `GEMINI_API_KEY`), `Bearer` tokens, `xi-api-key` headers, and query-string `token=` values are automatically scrubbed via `sanitizeSecretsFromText()` before any error message or log entry is stored or returned.
- No UI input field for entering raw commercial API keys is exposed in the client browser; external provider calls route strictly through `/api/v1/...` server endpoints.

## 2. Streaming Authentication & Ephemeral Privacy
- **Single-Use Short-Lived Session Tokens:** WebSocket sessions require a single-use token (`TTL = 30s`) issued by `POST /api/v1/streaming/sessions`. Reused or expired tokens are rejected with `STREAM_AUTH_FAILED` / `STREAM_SESSION_EXPIRED`.
- **Default Ephemeral Audio Policy (`privacy_mode = "ephemeral"`):** Raw audio frames are processed in bounded memory buffers and discarded immediately after utterance finalization. Diagnostic frame metadata is retained only when `privacy_mode = "diagnostic_opt_in"` and `retain_audio = true`.
