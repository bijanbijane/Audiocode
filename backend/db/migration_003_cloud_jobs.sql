-- apps/platform-backend/db/migration_003_cloud_jobs.sql

CREATE TABLE IF NOT EXISTS cloud_asr_jobs (
    job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

CREATE INDEX idx_cloud_jobs_queued ON cloud_asr_jobs(status, created_at) WHERE status = 'QUEUED';
CREATE INDEX idx_cloud_jobs_user_active ON cloud_asr_jobs(user_id, status);
