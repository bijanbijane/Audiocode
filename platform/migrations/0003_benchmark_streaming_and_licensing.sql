-- M-P0-02 / ADR-002 CONSOLIDATION MIGRATION
-- Extends 0001_phase10_commercial_postgres.sql & 0002_phase11_speech_intelligence.sql
-- Unifies Benchmark Lab (Phase 3), Real-Time Streaming (Phase 5), Ed25519 Model Delivery/Leasing,
-- Canary Rollout, and Transactional Outbox without conflicting with canonical `users` / `subscriptions` / `invoices`.

-- 1. Ed25519 Signed Offline License Leases
CREATE TABLE IF NOT EXISTS offline_license_leases (
  lease_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  device_fingerprint_hash CHAR(64) NOT NULL,
  signing_key_id VARCHAR(64) NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  offline_grace_expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_leases_user_device
  ON offline_license_leases (user_id, device_fingerprint_hash);

-- 2. AI Models Catalog & Chunked CDN Delivery + Telemetry
CREATE TABLE IF NOT EXISTS ai_models_catalog (
  model_id VARCHAR(64) NOT NULL,
  version VARCHAR(32) NOT NULL,
  task_type VARCHAR(32) NOT NULL CHECK (task_type IN ('VAD', 'PERSIAN_ASR', 'FORCED_ALIGNMENT', 'DISFLUENCY', 'DIARIZATION', 'DENOISER')),
  tier_group VARCHAR(16) NOT NULL CHECK (tier_group IN ('GROUP_A', 'GROUP_B', 'GROUP_C')),
  release_status VARCHAR(24) NOT NULL CHECK (release_status IN ('CANDIDATE', 'LIMITED_RELEASE', 'ACTIVE', 'SUPPORTED', 'DEPRECATED', 'ARCHIVED', 'REVOKED')),
  spdx_license VARCHAR(64) NOT NULL,
  quantization_format VARCHAR(32) NOT NULL,
  min_ram_mb INTEGER NOT NULL,
  recommended_ram_mb INTEGER NOT NULL,
  total_size_bytes BIGINT NOT NULL,
  manifest_ed25519_signature TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (model_id, version)
);

CREATE TABLE IF NOT EXISTS ai_model_chunks (
  model_id VARCHAR(64) NOT NULL,
  version VARCHAR(32) NOT NULL,
  chunk_index INTEGER NOT NULL,
  sha256_hex CHAR(64) NOT NULL,
  byte_length INTEGER NOT NULL,
  cdn_path TEXT NOT NULL,
  PRIMARY KEY (model_id, version, chunk_index),
  FOREIGN KEY (model_id, version) REFERENCES ai_models_catalog(model_id, version) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS model_delivery_telemetry (
  id BIGSERIAL PRIMARY KEY,
  model_id VARCHAR(64) NOT NULL,
  version VARCHAR(32) NOT NULL,
  event_type VARCHAR(32) NOT NULL CHECK (event_type IN ('CHUNK_DOWNLOAD_OK', 'CHUNK_FAILURE', 'RESUME_SUCCESS', 'CACHE_HIT')),
  chunk_index INTEGER,
  bytes_transferred BIGINT NOT NULL DEFAULT 0,
  device_tier VARCHAR(24),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_model_time
  ON model_delivery_telemetry (model_id, recorded_at DESC);

-- 3. Cloud Worker Queue, Model Rollout Policies & Outbox
CREATE TABLE IF NOT EXISTS cloud_asr_jobs (
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id VARCHAR(64) NOT NULL,
  audio_duration_seconds DOUBLE PRECISION NOT NULL,
  remote_storage_ref TEXT NOT NULL,
  status VARCHAR(24) NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD_LETTER')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  assigned_worker_id VARCHAR(64),
  lease_expires_at TIMESTAMPTZ,
  compute_cost_credits INTEGER NOT NULL DEFAULT 0,
  error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cloud_jobs_queued
  ON cloud_asr_jobs (status, created_at)
  WHERE status = 'QUEUED';

CREATE INDEX IF NOT EXISTS idx_cloud_jobs_user_active
  ON cloud_asr_jobs (user_id, status);

CREATE TABLE IF NOT EXISTS model_rollout_policies (
  model_id VARCHAR(64) PRIMARY KEY,
  stable_version VARCHAR(32) NOT NULL,
  candidate_version VARCHAR(32),
  canary_percentage INTEGER NOT NULL DEFAULT 0 CHECK (canary_percentage >= 0 AND canary_percentage <= 100),
  rollout_state VARCHAR(24) NOT NULL CHECK (rollout_state IN ('STABLE_ONLY', 'CANARY_ACTIVE', 'PROMOTED_GENERAL', 'HALTED_ROLLBACK')),
  max_failure_rate_pct DOUBLE PRECISION NOT NULL DEFAULT 5.0,
  min_telemetry_samples INTEGER NOT NULL DEFAULT 50,
  rollout_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS backend_event_outbox (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type VARCHAR(48) NOT NULL,
  aggregate_id VARCHAR(128) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload_json JSONB NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DISPATCHED', 'DEAD_LETTER')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON backend_event_outbox (status, next_attempt_at)
  WHERE status = 'PENDING';

-- 4. Phase 3 Benchmarking Tables (Canonicalized from ENGINEERING/DATABASE-SCHEMA.md)
CREATE TABLE IF NOT EXISTS asr_engines (
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

CREATE TABLE IF NOT EXISTS dataset_samples (
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

CREATE TABLE IF NOT EXISTS benchmark_experiments (
  experiment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state VARCHAR(32) NOT NULL,
  normalization_version VARCHAR(32) NOT NULL,
  config_hash CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS benchmark_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id UUID NOT NULL REFERENCES benchmark_experiments(experiment_id) ON DELETE CASCADE,
  sample_id VARCHAR(64) NOT NULL REFERENCES dataset_samples(sample_id) ON DELETE RESTRICT,
  engine_id VARCHAR(64) NOT NULL REFERENCES asr_engines(engine_id) ON DELETE RESTRICT,
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
  UNIQUE (experiment_id, sample_id, engine_id)
);

-- 5. Phase 5 Real-Time Streaming Tables
CREATE TABLE IF NOT EXISTS stream_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS stream_utterances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  UNIQUE (session_id, utterance_index)
);

CREATE TABLE IF NOT EXISTS stream_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
  utterance_id UUID,
  event_sequence INTEGER NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  revision INTEGER,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, event_sequence)
);

CREATE INDEX IF NOT EXISTS idx_stream_sessions_user_created ON stream_sessions (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stream_sessions_state_activity ON stream_sessions (state, last_activity_at);
CREATE INDEX IF NOT EXISTS idx_stream_utterances_session_idx ON stream_utterances (session_id, utterance_index);
CREATE INDEX IF NOT EXISTS idx_stream_events_session_seq ON stream_events (session_id, event_sequence);
