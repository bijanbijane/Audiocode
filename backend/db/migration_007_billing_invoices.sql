-- backend/db/migration_007_billing_invoices.sql

CREATE SEQUENCE IF NOT EXISTS billing_invoice_seq START 1001;

CREATE TABLE IF NOT EXISTS billing_invoices (
    invoice_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number VARCHAR(32) UNIQUE NOT NULL, -- e.g. INV-2026-001001
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    payment_transaction_id UUID UNIQUE NOT NULL REFERENCES payment_transactions(id) ON DELETE RESTRICT,
    plan_tier VARCHAR(32) NOT NULL,
    currency VARCHAR(8) NOT NULL,
    subtotal_minor_units BIGINT NOT NULL,
    tax_rate_bps INTEGER NOT NULL, -- Basis Points: 1000 = 10.00% VAT
    tax_minor_units BIGINT NOT NULL,
    total_minor_units BIGINT NOT NULL,
    immutable_snapshot_json JSONB NOT NULL,
    snapshot_sha256_hex CHAR(64) NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_billing_invoices_user ON billing_invoices(user_id, issued_at DESC);
