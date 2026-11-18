-- PHASE 11 — SPEECH INTELLIGENCE PRODUCT SUITE POSTGRESQL SCHEMA
-- Extends /platform/migrations/0001_phase10_commercial_postgres.sql cleanly without modifying ASR core tables.

-- 16.1 intelligence_jobs
CREATE TABLE IF NOT EXISTS intelligence_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  recording_id TEXT NOT NULL,
  region_id TEXT NOT NULL DEFAULT 'ir-thr-01',
  status TEXT NOT NULL CHECK (
    status IN ('ACCEPTED', 'VALIDATING', 'QUEUED', 'RUNNING', 'PARTIALLY_COMPLETED', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED')
  ),
  requested_capabilities JSONB NOT NULL,
  completed_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  failed_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key TEXT,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (organization_id, project_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_intel_jobs_tenant_rec
  ON intelligence_jobs (organization_id, project_id, recording_id, created_at DESC);

-- 16.2 capability_executions
CREATE TABLE IF NOT EXISTS capability_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES intelligence_jobs(id) ON DELETE CASCADE,
  capability_id TEXT NOT NULL,
  capability_version TEXT NOT NULL,
  worker_pool TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED_DEPENDENCY')),
  configuration_hash TEXT NOT NULL,
  input_artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  output_artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  resource_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  cost_amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (cost_amount_minor >= 0),
  cost_currency CHAR(3) NOT NULL DEFAULT 'USD',
  error_code TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cap_exec_job ON capability_executions (job_id, capability_id);

-- 16.3 speech_artifacts (Immutable provenance versions; deleted_at cascades across derived outputs)
CREATE TABLE IF NOT EXISTS speech_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  recording_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (
    artifact_type IN (
      'ORIGINAL_AUDIO', 'ASR_HYPOTHESIS', 'USER_CORRECTED_TRANSCRIPT', 'APPROVED_TRANSCRIPT',
      'DIARIZATION', 'ALIGNMENT', 'TRANSLATION', 'SUBTITLES',
      'MEETING_INTELLIGENCE', 'CONVERSATION_ANALYTICS', 'SEMANTIC_INDEX', 'STRUCTURED_EXTRACTION'
    )
  ),
  artifact_version INTEGER NOT NULL CHECK (artifact_version >= 1),
  source_artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  content_location TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  media_type TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('fa', 'en', 'fa-en')),
  model_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  configuration_hash TEXT NOT NULL,
  provenance JSONB NOT NULL,
  retention_policy_id TEXT NOT NULL DEFAULT 'ret_30d',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (organization_id, project_id, recording_id, artifact_type, artifact_version)
);

CREATE INDEX IF NOT EXISTS idx_speech_artifacts_lookup
  ON speech_artifacts (organization_id, project_id, recording_id, artifact_type)
  WHERE deleted_at IS NULL;

-- 16.4 speaker_segments (Anonymous local labels only; biometric identity forbidden)
CREATE TABLE IF NOT EXISTS speaker_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id UUID NOT NULL REFERENCES speech_artifacts(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recording_id TEXT NOT NULL,
  speaker_id TEXT NOT NULL,
  start_time DOUBLE PRECISION NOT NULL CHECK (start_time >= 0),
  end_time DOUBLE PRECISION NOT NULL CHECK (end_time >= start_time),
  confidence DOUBLE PRECISION,
  overlap_status BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_speaker_segments_rec ON speaker_segments (organization_id, recording_id, start_time);

-- 16.5 translations (Strictly separated from source transcripts)
CREATE TABLE IF NOT EXISTS translations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_artifact_id UUID NOT NULL REFERENCES speech_artifacts(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL CHECK (target_language IN ('fa', 'en')),
  translation_artifact_id UUID NOT NULL REFERENCES speech_artifacts(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'BLOCKED_BY_EXTERNAL_DEPENDENCY', 'FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 16.6 semantic_index_chunks (Authoritative tenant permissions enforced at relational filter boundary)
CREATE TABLE IF NOT EXISTS semantic_index_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  recording_id TEXT NOT NULL,
  artifact_id UUID NOT NULL REFERENCES speech_artifacts(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  speaker_id TEXT,
  language TEXT NOT NULL,
  start_time DOUBLE PRECISION NOT NULL,
  end_time DOUBLE PRECISION NOT NULL,
  transcript_version INTEGER NOT NULL,
  embedding_provider_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_semantic_chunks_tenant
  ON semantic_index_chunks (organization_id, project_id, recording_id)
  WHERE deleted_at IS NULL;

-- 16.7 enterprise_connectors
CREATE TABLE IF NOT EXISTS enterprise_connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  connector_kind TEXT NOT NULL,
  name TEXT NOT NULL,
  config_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE_LOCAL_TEST_ADAPTER', 'BLOCKED_BY_EXTERNAL_DEPENDENCY', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
