-- apps/platform-backend/db/migration_004_model_rollout.sql

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
