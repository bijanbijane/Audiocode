-- PHASE 13 — ASR MODEL FACTORY, MLOPS, REPRODUCIBLE TRAINING, MODEL REGISTRY & LIFECYCLE GOVERNANCE
-- Extends 0001..0004 without duplicating organizations, projects, datasets, or dataset_releases.
-- Model weights & large evaluation reports are stored externally by content-addressed URI + SHA-256 digest.

-- 20.1 ml_experiments
CREATE TABLE IF NOT EXISTS ml_experiments (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_experiment_id TEXT REFERENCES ml_experiments(id) ON DELETE SET NULL,
  experiment_name TEXT NOT NULL,
  objective TEXT NOT NULL,
  hypothesis_json JSONB NOT NULL,
  model_family TEXT NOT NULL,
  architecture TEXT NOT NULL,
  initialization_type TEXT NOT NULL CHECK (
    initialization_type IN (
      'PRETRAINED_INFERENCE',
      'FULL_FINE_TUNING',
      'PARAMETER_EFFICIENT_FINE_TUNING',
      'ADAPTER_TUNING',
      'RANDOM_INITIALIZATION',
      'SELF_SUPERVISED_PRETRAINING',
      'DISTILLATION'
    )
  ),
  base_model_version TEXT NOT NULL,
  configuration_json JSONB NOT NULL,
  configuration_hash CHAR(64) NOT NULL,
  dataset_release_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  dataset_manifest_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_commit TEXT NOT NULL,
  dependency_lockfile TEXT NOT NULL,
  container_image_digest TEXT NOT NULL,
  reproducibility_level TEXT NOT NULL CHECK (
    reproducibility_level IN (
      'CONFIGURATION_REPRODUCIBLE',
      'ENVIRONMENT_REPRODUCIBLE',
      'DATA_REPRODUCIBLE',
      'EXECUTION_REPRODUCIBLE',
      'BITWISE_REPRODUCIBLE'
    )
  ),
  status TEXT NOT NULL DEFAULT 'CREATED',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ml_experiments_tenant ON ml_experiments (tenant_id, project_id, created_at DESC);

-- 20.2 training_runs
CREATE TABLE IF NOT EXISTS training_runs (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL REFERENCES ml_experiments(id) ON DELETE RESTRICT,
  dataset_release_id TEXT NOT NULL,
  dataset_manifest_hash CHAR(64) NOT NULL,
  resource_class TEXT NOT NULL CHECK (resource_class IN ('CPU_ONLY', 'GPU_SMALL', 'GPU_MEDIUM', 'GPU_LARGE', 'MULTI_GPU')),
  priority_class TEXT NOT NULL DEFAULT 'STANDARD',
  training_status TEXT NOT NULL CHECK (
    training_status IN (
      'CREATED', 'VALIDATING', 'QUEUED', 'INITIALIZING', 'RUNNING',
      'CHECKPOINTING', 'EVALUATING', 'COMPLETED', 'FAILED', 'CANCELLED',
      'INTERRUPTED', 'BLOCKED'
    )
  ),
  preflight_report JSONB NOT NULL DEFAULT '{}'::jsonb,
  environment_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  random_seeds JSONB NOT NULL DEFAULT '{}'::jsonb,
  resumed_from_checkpoint_id TEXT,
  failure_category TEXT,
  failure_reason TEXT,
  compute_telemetry JSONB NOT NULL DEFAULT '{}'::jsonb,
  cost_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_training_runs_exp_status ON training_runs (tenant_id, experiment_id, training_status);

-- 20.3 training_checkpoints
CREATE TABLE IF NOT EXISTS training_checkpoints (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL REFERENCES ml_experiments(id) ON DELETE CASCADE,
  training_run_id TEXT NOT NULL REFERENCES training_runs(id) ON DELETE CASCADE,
  global_step INTEGER NOT NULL CHECK (global_step >= 0),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  checkpoint_type TEXT NOT NULL CHECK (checkpoint_type IN ('TEMPORARY', 'PERIODIC', 'BEST_VALIDATION', 'FINAL', 'INTERRUPTION_RECOVERY')),
  integrity_status TEXT NOT NULL CHECK (integrity_status IN ('STAGING', 'COMMITTED', 'CORRUPT')),
  architecture TEXT NOT NULL,
  tokenizer_version TEXT NOT NULL,
  artifact_location TEXT NOT NULL,
  artifact_hash CHAR(64) NOT NULL,
  optimizer_state_included BOOLEAN NOT NULL DEFAULT TRUE,
  scheduler_state_included BOOLEAN NOT NULL DEFAULT TRUE,
  random_state_included BOOLEAN NOT NULL DEFAULT TRUE,
  validation_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  protected_from_retention_gc BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_training_checkpoints_run ON training_checkpoints (training_run_id, global_step DESC);

-- 20.4 model_versions
CREATE TABLE IF NOT EXISTS model_versions (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  version TEXT NOT NULL,
  model_family TEXT NOT NULL,
  architecture TEXT NOT NULL,
  initialization_type TEXT NOT NULL,
  base_model_reference TEXT NOT NULL,
  parent_model_version_id TEXT REFERENCES model_versions(id) ON DELETE SET NULL,
  training_experiment_id TEXT REFERENCES ml_experiments(id) ON DELETE RESTRICT,
  dataset_lineage JSONB NOT NULL DEFAULT '[]'::jsonb,
  tokenizer_version TEXT NOT NULL,
  configuration_hash CHAR(64) NOT NULL,
  weights_artifact_hash CHAR(64) NOT NULL,
  artifact_checksums JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  license_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  license_status TEXT NOT NULL CHECK (license_status IN ('VERIFIED_COMMERCIAL', 'NON_COMMERCIAL_RESEARCH', 'RESTRICTED', 'UNKNOWN')),
  lifecycle_status TEXT NOT NULL CHECK (
    lifecycle_status IN (
      'RESEARCH', 'TRAINED', 'EVALUATED', 'CANDIDATE', 'APPROVED',
      'STAGED', 'CANARY', 'PRODUCTION', 'REJECTED', 'BLOCKED',
      'DEPRECATED', 'ARCHIVED', 'WITHDRAWN'
    )
  ),
  model_card JSONB NOT NULL DEFAULT '{}'::jsonb,
  declared_capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  immutable BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, model_id, version)
);

CREATE INDEX IF NOT EXISTS idx_model_versions_lifecycle ON model_versions (tenant_id, model_id, lifecycle_status);

-- 20.5 model_packages
CREATE TABLE IF NOT EXISTS model_packages (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  package_hash CHAR(64) NOT NULL,
  runtime_compatibility JSONB NOT NULL DEFAULT '{}'::jsonb,
  compatibility_passed BOOLEAN NOT NULL DEFAULT FALSE,
  security_scan_passed BOOLEAN NOT NULL DEFAULT FALSE,
  package_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 20.6 model_evaluations
CREATE TABLE IF NOT EXISTS model_evaluations (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL REFERENCES ml_experiments(id) ON DELETE CASCADE,
  model_version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  dataset_release_id TEXT NOT NULL,
  dataset_split TEXT NOT NULL CHECK (dataset_split IN ('VALIDATION', 'TEST', 'HOLDOUT')),
  metric_policy_version TEXT NOT NULL,
  normalization_configuration TEXT NOT NULL,
  evaluation_configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  report_artifact_id TEXT NOT NULL,
  report_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  promotion_gate_passed BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'BLOCKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_evaluations_version ON model_evaluations (tenant_id, model_version_id, created_at DESC);

-- 20.7 model_approvals
CREATE TABLE IF NOT EXISTS model_approvals (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  evaluation_report_id TEXT NOT NULL REFERENCES model_evaluations(id) ON DELETE RESTRICT,
  approval_scope TEXT NOT NULL,
  approver_id TEXT NOT NULL,
  approver_role TEXT NOT NULL,
  approval_status TEXT NOT NULL CHECK (approval_status IN ('APPROVED', 'REJECTED', 'REVOKED')),
  approval_reason TEXT NOT NULL,
  accepted_limitations JSONB NOT NULL DEFAULT '[]'::jsonb,
  rollback_reference_version_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 20.8 model_deployments
CREATE TABLE IF NOT EXISTS model_deployments (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
  previous_model_version_id TEXT REFERENCES model_versions(id) ON DELETE SET NULL,
  environment TEXT NOT NULL CHECK (environment IN ('DEVELOPMENT', 'STAGING', 'SHADOW', 'CANARY', 'PRODUCTION')),
  deployment_strategy TEXT NOT NULL CHECK (deployment_strategy IN ('DIRECT_DEV', 'STAGING', 'SHADOW', 'CANARY', 'FULL_PRODUCTION', 'ROLLBACK')),
  traffic_percentage INTEGER NOT NULL CHECK (traffic_percentage >= 0 AND traffic_percentage <= 100),
  session_pinning_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  active_pinned_sessions INTEGER NOT NULL DEFAULT 0,
  serving_health TEXT NOT NULL CHECK (serving_health IN ('HEALTHY', 'DEGRADED', 'UNAVAILABLE', 'LOADING', 'DRAINING')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PROMOTED', 'ROLLED_BACK', 'FAILED', 'DRAINING')),
  configuration_hash CHAR(64) NOT NULL,
  rollback_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_model_deployments_env ON model_deployments (tenant_id, environment, status);

-- 20.9 model_deployment_events (Immutable audit log of promotions, traffic ramps, rollbacks)
CREATE TABLE IF NOT EXISTS model_deployment_events (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL REFERENCES model_deployments(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  previous_model_version TEXT,
  new_model_version TEXT,
  actor_id TEXT NOT NULL,
  event_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 20.10 model_monitoring_events
CREATE TABLE IF NOT EXISTS model_monitoring_events (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE CASCADE,
  deployment_id TEXT NOT NULL REFERENCES model_deployments(id) ON DELETE CASCADE,
  drift_dimension TEXT NOT NULL CHECK (drift_dimension IN ('OPERATIONAL_TELEMETRY', 'FEATURE_DISTRIBUTION_DRIFT', 'DATA_QUALITY_DRIFT', 'MODEL_PERFORMANCE_DRIFT')),
  metric_name TEXT NOT NULL,
  metric_value DOUBLE PRECISION NOT NULL,
  metric_window TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  safe_summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_monitoring_severity ON model_monitoring_events (tenant_id, model_version_id, severity, created_at DESC);
