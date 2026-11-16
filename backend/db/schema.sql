-- backend/db/schema.sql
-- Platform Services PostgreSQL Schema (Domain 7 — Zero user audio/transcript storage)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. User accounts
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Subscriptions (Local processing entitlement decoupled from future cloud credits)
CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_tier VARCHAR(32) NOT NULL CHECK (plan_tier IN ('FREE_TRIAL', 'PRO_MONTHLY', 'PRO_ANNUAL', 'STUDIO_ENTERPRISE')),
    status VARCHAR(32) NOT NULL CHECK (status IN ('ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED')),
    current_period_start TIMESTAMPTZ NOT NULL,
    current_period_end TIMESTAMPTZ NOT NULL,
    offline_grace_hours INTEGER NOT NULL DEFAULT 168,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_subscriptions_user_status ON subscriptions(user_id, status);

-- 3. Ed25519 Signed Offline License Leases
CREATE TABLE offline_license_leases (
    lease_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    device_fingerprint_hash CHAR(64) NOT NULL,
    signing_key_id VARCHAR(64) NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    offline_grace_expires_at TIMESTAMPTZ NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_leases_user_device ON offline_license_leases(user_id, device_fingerprint_hash);

-- 4. Persian AI Model Catalog Registry
CREATE TABLE ai_models_catalog (
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

-- 5. Content-Addressable 8MB Model Chunks for Resumable CDN Delivery
CREATE TABLE ai_model_chunks (
    model_id VARCHAR(64) NOT NULL,
    version VARCHAR(32) NOT NULL,
    chunk_index INTEGER NOT NULL,
    sha256_hex CHAR(64) NOT NULL,
    byte_length INTEGER NOT NULL,
    cdn_path TEXT NOT NULL,
    PRIMARY KEY (model_id, version, chunk_index),
    FOREIGN KEY (model_id, version) REFERENCES ai_models_catalog(model_id, version) ON DELETE CASCADE
);

-- 6. Privacy-Safe CDN Delivery Telemetry (Zero user project/audio metadata)
CREATE TABLE model_delivery_telemetry (
    id BIGSERIAL PRIMARY KEY,
    model_id VARCHAR(64) NOT NULL,
    version VARCHAR(32) NOT NULL,
    event_type VARCHAR(32) NOT NULL CHECK (event_type IN ('CHUNK_DOWNLOAD_OK', 'CHUNK_FAILURE', 'RESUME_SUCCESS', 'CACHE_HIT')),
    chunk_index INTEGER,
    bytes_transferred BIGINT NOT NULL DEFAULT 0,
    device_tier VARCHAR(24),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_telemetry_model_time ON model_delivery_telemetry(model_id, recorded_at DESC);
