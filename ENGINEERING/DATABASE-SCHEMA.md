# DATABASE SCHEMA SPECIFICATION — PHASE 3 & PHASE 5 DURABLE STORAGE

**Document Version:** `1.0.0-phase3-phase5`  
**Target RDBMS:** PostgreSQL 16+ (with In-Memory Repository Implementation for `G0_CPU_ONLY` Container)

---

## 1. Phase 3 Benchmarking Tables

```sql
CREATE TABLE asr_engines (
    engine_id VARCHAR(64) PRIMARY KEY,
    provider_name VARCHAR(64) NOT NULL,
    model_version VARCHAR(128) NOT NULL,
    deployment_type VARCHAR(32) NOT NULL,
    supports_persian BOOLEAN NOT NULL,
    supports_english BOOLEAN NOT NULL,
    supports_code_switching BOOLEAN NOT NULL,
    supports_streaming BOOLEAN NOT NULL,
    pricing_unit VARCHAR(32) NOT NULL,
    rate_usd NUMERIC(12, 6) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE dataset_samples (
    sample_id VARCHAR(64) PRIMARY KEY,
    audio_sha256 CHAR(64) NOT NULL UNIQUE,
    duration_sec NUMERIC(8, 3) NOT NULL CHECK (duration_sec >= 0.5 AND duration_sec <= 30.0),
    sample_rate INTEGER NOT NULL CHECK (sample_rate = 16000),
    channels INTEGER NOT NULL CHECK (channels = 1),
    language VARCHAR(16) NOT NULL,
    speaker_id VARCHAR(64) NOT NULL,
    assigned_split VARCHAR(32) NOT NULL,
    transcript_raw TEXT NOT NULL,
    snr_db NUMERIC(6, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE benchmark_experiments (
    experiment_id UUID PRIMARY KEY,
    state VARCHAR(32) NOT NULL,
    normalization_version VARCHAR(32) NOT NULL,
    config_hash CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE benchmark_runs (
    run_id UUID PRIMARY KEY,
    experiment_id UUID NOT NULL REFERENCES benchmark_experiments(experiment_id),
    sample_id VARCHAR(64) NOT NULL REFERENCES dataset_samples(sample_id),
    engine_id VARCHAR(64) NOT NULL REFERENCES asr_engines(engine_id),
    hypothesis_raw TEXT NOT NULL,
    hypothesis_normalized TEXT NOT NULL,
    cer_percent NUMERIC(6, 2) NOT NULL,
    wer_percent NUMERIC(6, 2) NOT NULL,
    char_substitutions INTEGER NOT NULL,
    char_deletions INTEGER NOT NULL,
    char_insertions INTEGER NOT NULL,
    ref_char_count INTEGER NOT NULL,
    latency_ms NUMERIC(10, 2) NOT NULL,
    cost_origin VARCHAR(32) NOT NULL,
    cost_usd NUMERIC(12, 6),
    UNIQUE(experiment_id, sample_id, engine_id)
);
```

---

## 2. Phase 5 Real-Time Streaming Tables (Section 17)

```sql
CREATE TABLE stream_sessions (
    id UUID PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    model_id VARCHAR(64) NOT NULL,
    model_revision VARCHAR(128) NOT NULL,
    backend_id VARCHAR(64) NOT NULL,
    mode VARCHAR(48) NOT NULL,
    language_requested VARCHAR(16) NOT NULL,
    language_detected VARCHAR(16),
    audio_sample_rate INTEGER NOT NULL DEFAULT 16000,
    audio_channels INTEGER NOT NULL DEFAULT 1,
    audio_encoding VARCHAR(32) NOT NULL DEFAULT 'pcm16_le',
    protocol_version VARCHAR(32) NOT NULL DEFAULT 'asr-stream-v1',
    state VARCHAR(32) NOT NULL,
    privacy_mode VARCHAR(32) NOT NULL DEFAULT 'ephemeral',
    retain_audio BOOLEAN NOT NULL DEFAULT FALSE,
    worker_id VARCHAR(64) NOT NULL,
    gpu_id VARCHAR(64) NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    last_activity_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE stream_utterances (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
    utterance_index INTEGER NOT NULL,
    start_sample BIGINT NOT NULL,
    end_sample BIGINT,
    language_detected VARCHAR(16),
    state VARCHAR(32) NOT NULL,
    transcript_raw TEXT NOT NULL,
    transcript_normalized TEXT,
    revision_count INTEGER NOT NULL DEFAULT 0,
    forced_boundary BOOLEAN NOT NULL DEFAULT FALSE,
    boundary_confidence NUMERIC(5, 4),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    first_partial_at TIMESTAMPTZ,
    finalized_at TIMESTAMPTZ,
    UNIQUE(session_id, utterance_index)
);

CREATE TABLE stream_events (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
    utterance_id UUID,
    event_sequence INTEGER NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    revision INTEGER,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(session_id, event_sequence)
);

CREATE INDEX idx_stream_sessions_user_created ON stream_sessions(user_id, created_at);
CREATE INDEX idx_stream_sessions_state_activity ON stream_sessions(state, last_activity_at);
CREATE INDEX idx_stream_utterances_session_idx ON stream_utterances(session_id, utterance_index);
CREATE INDEX idx_stream_events_session_seq ON stream_events(session_id, event_sequence);
```
