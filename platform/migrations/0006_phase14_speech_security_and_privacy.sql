-- PHASE 14 — SPEECH AI SECURITY, ADVERSARIAL ROBUSTNESS, PRIVACY ENGINEERING & MODEL ABUSE DEFENSE
-- Extends 0001..0005 cleanly without duplicating organizations, projects, model_versions, or datasets.

-- 21.1 Security Audit Events (Typed, Secret & Transcript Scrubbed)
CREATE TABLE IF NOT EXISTS security_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'AUDIO_UPLOAD_REJECTED',
      'URL_FETCH_SSRF_BLOCKED',
      'STREAMING_FRAME_REJECTED',
      'STREAMING_SESSION_HIJACK_BLOCKED',
      'QUOTA_OR_CONCURRENCY_EXCEEDED',
      'TRANSCRIPT_PROMPT_INJECTION_DETECTED',
      'TOOL_EXECUTION_UNAUTHORIZED_BLOCKED',
      'MODEL_ARTIFACT_TAMPER_OR_UNSAFE_BLOCKED',
      'DATASET_POISONING_ANOMALY_FLAGGED',
      'TENANT_CROSS_BOUNDARY_ACCESS_DENIED',
      'PII_REDACTION_DERIVATIVE_CREATED',
      'PRIVACY_RETENTION_DELETION_EXECUTED'
    )
  ),
  severity TEXT NOT NULL CHECK (severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  actor_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  action_outcome TEXT NOT NULL CHECK (action_outcome IN ('BLOCKED', 'FLAGGED', 'EXECUTED', 'DENIED')),
  sanitized_summary TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_audit_tenant_time
  ON security_audit_events (tenant_id, created_at DESC);

-- 21.2 Per-Artifact Independent Privacy Retention Policies
CREATE TABLE IF NOT EXISTS privacy_retention_policies (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  raw_audio_ttl_days INTEGER NOT NULL CHECK (raw_audio_ttl_days >= 0),
  intermediate_chunks_ttl_hours INTEGER NOT NULL CHECK (intermediate_chunks_ttl_hours >= 0),
  raw_transcript_ttl_days INTEGER NOT NULL CHECK (raw_transcript_ttl_days >= 0),
  redacted_transcript_ttl_days INTEGER NOT NULL CHECK (redacted_transcript_ttl_days >= 0),
  diagnostics_ttl_days INTEGER NOT NULL CHECK (diagnostics_ttl_days >= 1),
  security_logs_ttl_days INTEGER NOT NULL CHECK (security_logs_ttl_days >= 7),
  external_api_transfer_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  allowed_residency_region TEXT NOT NULL DEFAULT 'IR_LOCAL_ONLY',
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id)
);

-- 21.3 PII Redacted Transcript Derivatives (Preserving Verbatim Original Separately)
CREATE TABLE IF NOT EXISTS privacy_redacted_derivatives (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recording_id TEXT NOT NULL,
  source_transcript_version INTEGER NOT NULL,
  original_sha256 CHAR(64) NOT NULL,
  redacted_text TEXT NOT NULL,
  detected_pii_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  redaction_count INTEGER NOT NULL DEFAULT 0,
  detector_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_privacy_redacted_tenant_rec
  ON privacy_redacted_derivatives (tenant_id, recording_id, created_at DESC);

-- 21.4 Cascading Deletion Workflows
CREATE TABLE IF NOT EXISTS privacy_deletion_workflows (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recording_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'PARTIAL_PENDING_BACKUP_EXPIRY', 'FAILED')),
  deleted_artifacts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  backup_purge_note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 21.5 Remote URL Ingestion / SSRF Guard Policies (Disabled by Default)
CREATE TABLE IF NOT EXISTS ssrf_url_fetch_policies (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  remote_fetch_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  allowed_host_patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
  require_tls BOOLEAN NOT NULL DEFAULT TRUE,
  max_redirects INTEGER NOT NULL DEFAULT 0 CHECK (max_redirects >= 0 AND max_redirects <= 3),
  max_response_bytes BIGINT NOT NULL DEFAULT 52428800,
  request_timeout_ms INTEGER NOT NULL DEFAULT 5000,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id)
);

-- 21.6 Adversarial & Corruption Robustness Evaluation Runs
CREATE TABLE IF NOT EXISTS adversarial_robustness_runs (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_version_id TEXT NOT NULL,
  fixture_set_id TEXT NOT NULL,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('SYNTHETIC_AUTHORIZED_CPU', 'CONTROLLED_SANDBOX')),
  results_by_family_json JSONB NOT NULL,
  language_breakdown_json JSONB NOT NULL,
  limitations_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
