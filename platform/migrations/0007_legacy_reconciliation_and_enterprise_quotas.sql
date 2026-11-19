-- M-P0-02 / ADR-002 FORWARD-ONLY LEGACY RECONCILIATION MIGRATION (0007)
-- Reconciles remaining still-required billing, idempotent PSP payment transaction,
-- and enterprise API key quota semantics from legacy backend/db/migration_002, 006, 007
-- onto the canonical schema established by 0001..0006 without duplicating or dropping any table.

-- 1. Sequence & immutable SHA-256 snapshot columns on canonical `invoices` (from legacy migration_007)
CREATE SEQUENCE IF NOT EXISTS billing_invoice_seq START 1001;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS tax_rate_bps INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS snapshot_sha256_hex CHAR(64);

-- 2. Idempotent PSP Gateway Payment Transactions referencing canonical `users` & `invoices`
-- Complementary to webhook-level `payment_events` in 0001 (from legacy migration_002)
CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id UUID REFERENCES invoices(id) ON DELETE RESTRICT,
  gateway_name VARCHAR(32) NOT NULL,
  gateway_tx_id VARCHAR(128) NOT NULL,
  plan_tier VARCHAR(32) NOT NULL CHECK (plan_tier IN ('PRO_MONTHLY', 'PRO_ANNUAL', 'STUDIO_ENTERPRISE')),
  amount_minor_units BIGINT NOT NULL CHECK (amount_minor_units >= 0),
  currency VARCHAR(8) NOT NULL DEFAULT 'IRR',
  status VARCHAR(24) NOT NULL CHECK (status IN ('PENDING', 'VERIFIED_APPLIED', 'FAILED', 'REFUNDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (gateway_name, gateway_tx_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_transactions_user_created
  ON payment_transactions (user_id, created_at DESC);

-- 3. Scoped Enterprise API Key Audio Quota Ledger extending canonical `api_credentials`
-- Reconciles legacy `enterprise_api_keys` quota columns (migration_006) without duplicating `api_credentials`
CREATE TABLE IF NOT EXISTS enterprise_api_key_quotas (
  credential_id UUID PRIMARY KEY REFERENCES api_credentials(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  monthly_audio_seconds_limit BIGINT NOT NULL DEFAULT 36000 CHECK (monthly_audio_seconds_limit >= 0),
  monthly_audio_seconds_used BIGINT NOT NULL DEFAULT 0 CHECK (monthly_audio_seconds_used >= 0),
  period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_enterprise_key_quotas_org
  ON enterprise_api_key_quotas (organization_id);
