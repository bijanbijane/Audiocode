-- PHASE 12 — SPEECH DATA FACTORY, DATASET ENGINEERING, ANNOTATION GOVERNANCE & CORPUS QUALITY
-- Extends 0001..0003 without duplicating `organizations`, `projects`, `speech_artifacts`, or `dataset_samples`.
-- Stores external/object-storage references & SHA-256 provenance rather than large raw audio blobs in rows.

-- 16.1 data_sources
CREATE TABLE IF NOT EXISTS data_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (
    source_type IN (
      'AUTHORIZED_USER_UPLOAD',
      'ORGANIZATION_CONTROLLED_RECORDING',
      'EXPLICITLY_LICENSED_CORPUS',
      'APPROVED_PUBLIC_DATASET',
      'CONSENT_CONTRIBUTOR_RECORDING',
      'APPROVED_HUMAN_ANNOTATION_DELIVERY',
      'AUTHORIZED_PRODUCTION_FEEDBACK'
    )
  ),
  source_name TEXT NOT NULL,
  owner_reference TEXT NOT NULL,
  license_reference TEXT NOT NULL,
  provenance_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING', 'VERIFIED', 'REJECTED', 'REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_sources_tenant ON data_sources (tenant_id, verification_status);

-- 16.2 recordings
CREATE TABLE IF NOT EXISTS recordings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE RESTRICT,
  original_artifact_id UUID,
  speaker_ref TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  duration_seconds DOUBLE PRECISION NOT NULL CHECK (duration_seconds >= 0),
  sample_rate INTEGER NOT NULL CHECK (sample_rate > 0),
  channel_count INTEGER NOT NULL CHECK (channel_count >= 1),
  codec TEXT NOT NULL,
  media_type TEXT NOT NULL,
  file_size_bytes BIGINT NOT NULL CHECK (file_size_bytes > 0),
  checksum_sha256 CHAR(64) NOT NULL,
  audio_fingerprint TEXT NOT NULL,
  language_classification TEXT NOT NULL CHECK (language_classification IN ('fa', 'en', 'fa-en', 'other', 'unknown', 'uncertain')),
  ingestion_status TEXT NOT NULL CHECK (ingestion_status IN ('QUEUED', 'VALIDATED', 'QUARANTINED', 'REJECTED', 'CANCELLED', 'DELETED')),
  quality_class TEXT NOT NULL CHECK (quality_class IN ('CLEAN', 'ACCEPTABLE', 'CHALLENGING', 'POOR', 'UNUSABLE', 'UNKNOWN')),
  profiler_version TEXT NOT NULL DEFAULT 'acoustic-profiler-v1.0-heuristic',
  profiling_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_recordings_tenant_sha ON recordings (tenant_id, checksum_sha256);
CREATE INDEX IF NOT EXISTS idx_recordings_speaker_session ON recordings (tenant_id, speaker_ref, session_ref) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_recordings_fingerprint ON recordings (tenant_id, audio_fingerprint);

-- 16.3 rights_records (Default-deny + strict 8-purpose separation)
CREATE TABLE IF NOT EXISTS rights_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recording_id UUID NOT NULL UNIQUE REFERENCES recordings(id) ON DELETE CASCADE,
  license_id TEXT NOT NULL,
  license_url_or_doc_ref TEXT NOT NULL,
  license_version TEXT NOT NULL,
  permission_basis TEXT NOT NULL,
  consent_reference TEXT,
  transcribe_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  store_audio_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  retain_transcripts_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  research_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  training_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  evaluation_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  publish_derived_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  redistribution_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  commercial_use_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  permitted_purposes JSONB NOT NULL DEFAULT '[]'::jsonb,
  retention_policy_id TEXT NOT NULL DEFAULT 'ret_standard_365d',
  geographic_restrictions JSONB NOT NULL DEFAULT '[]'::jsonb,
  legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_status IN ('UNVERIFIED', 'VERIFIED', 'REJECTED', 'REVOKED')),
  expiration_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rights_eligibility ON rights_records (tenant_id, verification_status, training_allowed, evaluation_allowed) WHERE revoked_at IS NULL;

-- 16.4 audio_artifacts (Immutable lineage referencing original source)
CREATE TABLE IF NOT EXISTS audio_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recording_id UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL CHECK (
    artifact_type IN (
      'ORIGINAL_RAW',
      'CANONICAL_16K_MONO_PCM16',
      'STEREO_LEFT',
      'STEREO_RIGHT',
      'STEREO_PRESERVED',
      'REPAIRED',
      'AUGMENTED'
    )
  ),
  artifact_version INTEGER NOT NULL CHECK (artifact_version >= 1),
  parent_artifact_id UUID REFERENCES audio_artifacts(id) ON DELETE RESTRICT,
  storage_location TEXT NOT NULL,
  checksum_sha256 CHAR(64) NOT NULL,
  sample_rate INTEGER NOT NULL,
  channel_count INTEGER NOT NULL,
  duration_seconds DOUBLE PRECISION NOT NULL,
  transformation_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  processing_software_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_audio_artifacts_rec ON audio_artifacts (recording_id, artifact_type, artifact_version);

-- 16.5 annotations
CREATE TABLE IF NOT EXISTS annotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  recording_id UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  annotator_id TEXT NOT NULL,
  annotation_version INTEGER NOT NULL CHECK (annotation_version >= 1),
  annotation_type TEXT NOT NULL CHECK (annotation_type IN ('UTTERANCE_TRANSCRIPT', 'CODE_SWITCH_TOKENS', 'SPEAKER_SEGMENTS', 'NON_SPEECH_EVENTS')),
  language TEXT NOT NULL CHECK (language IN ('fa', 'en', 'fa-en', 'other', 'unknown', 'uncertain')),
  policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'UNANNOTATED', 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'REVIEWED',
      'APPROVED', 'NEEDS_CORRECTION', 'REJECTED', 'DISPUTED', 'ADJUDICATION_REQUIRED'
    )
  ),
  is_blind_independent BOOLEAN NOT NULL DEFAULT TRUE,
  content_artifact_id TEXT NOT NULL,
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_annotations_rec_status ON annotations (tenant_id, recording_id, status);

-- 16.6 annotation_reviews (Preserves full disagreement and adjudication history)
CREATE TABLE IF NOT EXISTS annotation_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  annotation_id UUID NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL,
  review_status TEXT NOT NULL CHECK (review_status IN ('APPROVED', 'NEEDS_CORRECTION', 'REJECTED', 'DISPUTED', 'ADJUDICATED')),
  disagreement_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  adjudication_artifact_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_annotation_reviews_ann ON annotation_reviews (annotation_id, created_at DESC);

-- 16.7 dataset_releases (Immutable published releases)
CREATE TABLE IF NOT EXISTS dataset_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dataset_name TEXT NOT NULL,
  version TEXT NOT NULL,
  release_type TEXT NOT NULL CHECK (release_type IN ('TRAIN', 'VALIDATION', 'TEST', 'CHALLENGE', 'REGRESSION', 'STREAMING_EVALUATION', 'RESEARCH_ONLY')),
  manifest_artifact_id TEXT NOT NULL,
  configuration_hash CHAR(64) NOT NULL,
  split_policy JSONB NOT NULL,
  sealed_test_protected BOOLEAN NOT NULL DEFAULT TRUE,
  release_status TEXT NOT NULL CHECK (release_status IN ('DRAFT', 'PUBLISHED', 'SEALED', 'DEPRECATED', 'REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, dataset_name, version)
);

-- 16.8 dataset_memberships
CREATE TABLE IF NOT EXISTS dataset_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_release_id UUID NOT NULL REFERENCES dataset_releases(id) ON DELETE CASCADE,
  recording_id UUID NOT NULL REFERENCES recordings(id) ON DELETE RESTRICT,
  artifact_id UUID REFERENCES audio_artifacts(id) ON DELETE RESTRICT,
  split TEXT NOT NULL CHECK (split IN ('TRAIN', 'VALIDATION', 'TEST', 'CHALLENGE', 'REGRESSION', 'STREAMING_EVALUATION', 'RESEARCH_ONLY')),
  inclusion_reason TEXT,
  exclusion_reason TEXT,
  UNIQUE (dataset_release_id, recording_id)
);

CREATE INDEX IF NOT EXISTS idx_dataset_memberships_split ON dataset_memberships (dataset_release_id, split);

-- 16.9 dataset_audits
CREATE TABLE IF NOT EXISTS dataset_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dataset_release_id UUID NOT NULL REFERENCES dataset_releases(id) ON DELETE CASCADE,
  audit_type TEXT NOT NULL CHECK (audit_type IN ('LEAKAGE_AND_CONTAMINATION', 'RIGHTS_VERIFICATION', 'DIVERSITY_BALANCE')),
  status TEXT NOT NULL CHECK (status IN ('PASSED', 'FAILED_WITH_VIOLATIONS', 'PASSED_WITH_LIMITATIONS')),
  report_artifact_id TEXT NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
