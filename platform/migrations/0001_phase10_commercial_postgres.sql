-- PHASE 10 — COMMERCIAL CONTROL PLANE & USAGE LEDGER POSTGRESQL SCHEMA
-- Follows Section 20 (Expand-Migrate-Contract compatible, integer minor currency units, immutable invoices/ledger).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 20.1 users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  identity_provider TEXT NOT NULL DEFAULT 'local_password',
  account_status TEXT NOT NULL CHECK (account_status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 20.2 organizations
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  billing_customer_reference TEXT UNIQUE,
  organization_status TEXT NOT NULL CHECK (organization_status IN ('ACTIVE', 'RESTRICTED', 'SUSPENDED')),
  default_region TEXT NOT NULL DEFAULT 'ir-thr-01',
  prohibited_regions JSONB NOT NULL DEFAULT '[]'::jsonb,
  hard_spending_limit_minor BIGINT NOT NULL DEFAULT 5000,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 20.3 organization_memberships
CREATE TABLE IF NOT EXISTS organization_memberships (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'DEVELOPER', 'BILLING_ADMIN', 'ANALYST', 'VIEWER', 'SECURITY_AUDITOR')),
  membership_status TEXT NOT NULL CHECK (membership_status IN ('ACTIVE', 'REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);

-- 20.4 projects
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_name TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('DEVELOPMENT', 'STAGING', 'PRODUCTION')),
  allowed_models JSONB NOT NULL DEFAULT '["asr-fa-en-v1"]'::jsonb,
  allowed_regions JSONB NOT NULL DEFAULT '["ir-thr-01"]'::jsonb,
  retention_policy_id TEXT NOT NULL DEFAULT 'ret_30d',
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 20.5 api_credentials (Plaintext secret NEVER stored)
CREATE TABLE IF NOT EXISTS api_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  public_identifier TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL CHECK (key_prefix IN ('asr_live', 'asr_test')),
  environment TEXT NOT NULL CHECK (environment IN ('DEVELOPMENT', 'STAGING', 'PRODUCTION')),
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ,
  overlap_revokes_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 20.6 plans
CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_name TEXT NOT NULL,
  plan_version TEXT NOT NULL,
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('monthly', 'contract')),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  subscription_price_minor BIGINT NOT NULL,
  included_audio_seconds BIGINT NOT NULL,
  quotas JSONB NOT NULL,
  feature_entitlements JSONB NOT NULL,
  plan_status TEXT NOT NULL CHECK (plan_status IN ('ACTIVE', 'DEPRECATED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (plan_name, plan_version)
);

-- 20.7 subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES plans(id),
  plan_version TEXT NOT NULL,
  payment_customer_reference TEXT,
  payment_subscription_reference TEXT,
  subscription_status TEXT NOT NULL CHECK (subscription_status IN ('ACTIVE', 'PAST_DUE', 'CANCELLED')),
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  cancellation_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 20.8 usage_events (Authoritative Metering)
CREATE TABLE IF NOT EXISTS usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  usage_event_id TEXT NOT NULL UNIQUE,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  credential_id UUID REFERENCES api_credentials(id),
  request_id TEXT NOT NULL,
  transcription_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  meter_name TEXT NOT NULL DEFAULT 'audio_milliseconds',
  quantity_integer BIGINT NOT NULL CHECK (quantity_integer >= 0),
  unit TEXT NOT NULL DEFAULT 'audio_milliseconds',
  measurement_version TEXT NOT NULL DEFAULT 'meter-v1.0',
  actual_cost_minor BIGINT NOT NULL CHECK (actual_cost_minor >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  event_status TEXT NOT NULL CHECK (event_status IN ('RECEIVED', 'VALIDATED', 'RESERVED', 'COMMITTED', 'RECONCILED', 'REVERSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 20.9 usage_reservations
CREATE TABLE IF NOT EXISTS usage_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  request_id TEXT NOT NULL UNIQUE,
  estimated_quantity BIGINT NOT NULL,
  reserved_amount_minor BIGINT NOT NULL CHECK (reserved_amount_minor >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  reservation_status TEXT NOT NULL CHECK (reservation_status IN ('RESERVED', 'COMMITTED', 'RELEASED')),
  expires_at TIMESTAMPTZ NOT NULL,
  committed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ
);

-- 20.10 billing_ledger (Append-only immutable double-entry ledger)
CREATE TABLE IF NOT EXISTS billing_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  transaction_type TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  debit_account TEXT NOT NULL,
  credit_account TEXT NOT NULL,
  usage_event_id TEXT,
  invoice_id UUID,
  payment_event_id UUID,
  idempotency_key TEXT NOT NULL UNIQUE,
  transaction_status TEXT NOT NULL DEFAULT 'SETTLED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 20.11 invoices (Immutable snapshot after ISSUED)
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  invoice_number TEXT NOT NULL UNIQUE,
  pricing_snapshot JSONB NOT NULL,
  subtotal_minor BIGINT NOT NULL,
  tax_minor BIGINT NOT NULL DEFAULT 0,
  discount_minor BIGINT NOT NULL DEFAULT 0,
  total_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  issue_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_date TIMESTAMPTZ NOT NULL,
  invoice_status TEXT NOT NULL CHECK (invoice_status IN ('DRAFT', 'ISSUED', 'PAYMENT_PENDING', 'PAID', 'PARTIALLY_PAID', 'OVERDUE', 'VOID', 'REFUNDED')),
  payment_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 20.12 payment_events
CREATE TABLE IF NOT EXISTS payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_customer_reference TEXT,
  event_type TEXT NOT NULL,
  event_signature_valid BOOLEAN NOT NULL,
  event_status TEXT NOT NULL,
  processed_at TIMESTAMPTZ,
  payload_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_event_id)
);

-- 20.13 webhook_endpoints
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  endpoint_url TEXT NOT NULL,
  event_subscriptions JSONB NOT NULL,
  signing_secret_reference TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 20.14 webhook_deliveries
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  attempt_number INT NOT NULL DEFAULT 1,
  http_status INT,
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('PENDING', 'DELIVERED', 'RETRY_SCHEDULED', 'DEAD_LETTER')),
  next_retry_at TIMESTAMPTZ,
  last_error_safe TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
