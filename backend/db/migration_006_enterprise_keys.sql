-- backend/db/migration_006_enterprise_keys.sql
-- Section 138: Scoped B2B Enterprise API Keys & Atomic Audio Quota Ledger

CREATE TABLE IF NOT EXISTS enterprise_api_keys (
    key_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    key_prefix VARCHAR(20) NOT NULL,
    key_sha256_hex CHAR(64) UNIQUE NOT NULL,
    scopes TEXT[] NOT NULL, -- e.g., {'MODELS_READ', 'EXTERNAL_GATEWAY', 'CLOUD_ASR_ENTERPRISE'}
    monthly_audio_seconds_limit BIGINT NOT NULL DEFAULT 36000, -- Default 10 hours/month
    monthly_audio_seconds_used BIGINT NOT NULL DEFAULT 0,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_enterprise_keys_hash
    ON enterprise_api_keys(key_sha256_hex)
    WHERE revoked = FALSE;
