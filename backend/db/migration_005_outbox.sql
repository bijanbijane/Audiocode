-- apps/platform-backend/db/migration_005_outbox.sql

CREATE TABLE IF NOT EXISTS backend_event_outbox (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(48) NOT NULL, -- e.g. 'SUBSCRIPTION', 'MODEL_CATALOG', 'LICENSE_LEASE'
    aggregate_id VARCHAR(128) NOT NULL,
    event_type VARCHAR(64) NOT NULL,     -- e.g. 'MODEL_REVOKED', 'SUBSCRIPTION_RENEWED'
    payload_json JSONB NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DISPATCHED', 'DEAD_LETTER')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_outbox_pending ON backend_event_outbox(status, next_attempt_at) WHERE status = 'PENDING';
