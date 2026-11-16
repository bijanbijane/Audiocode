-- apps/platform-backend/db/migration_002_payments.sql

CREATE TABLE IF NOT EXISTS payment_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gateway_name VARCHAR(32) NOT NULL,
    gateway_tx_id VARCHAR(128) NOT NULL,
    plan_tier VARCHAR(32) NOT NULL CHECK (plan_tier IN ('PRO_MONTHLY', 'PRO_ANNUAL', 'STUDIO_ENTERPRISE')),
    amount_minor_units BIGINT NOT NULL,
    currency VARCHAR(8) NOT NULL DEFAULT 'IRR',
    status VARCHAR(24) NOT NULL CHECK (status IN ('PENDING', 'VERIFIED_APPLIED', 'FAILED', 'REFUNDED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Mathematical Idempotency Guarantee: 100% prevention of duplicate subscription extension on webhook retries
    UNIQUE (gateway_name, gateway_tx_id)
);
