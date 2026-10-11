-- Invoice proposed schools before creating any organisation or School tenant.
-- A paid setup invoice is claimed once, inside the tenant-creation transaction.
CREATE TABLE IF NOT EXISTS saas_school_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_organisation_id uuid NOT NULL REFERENCES organisations(id),
  invoice_no varchar(60) NOT NULL,
  school_details jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'issued' CHECK(status IN('issued','part_paid','paid','void')),
  currency char(3) NOT NULL,
  total numeric(14,2) NOT NULL CHECK(total>0),
  amount_paid numeric(14,2) NOT NULL DEFAULT 0 CHECK(amount_paid>=0 AND amount_paid<=total),
  due_at timestamptz NOT NULL,
  paid_at timestamptz,
  claimed_school_id uuid REFERENCES organisations(id),
  claimed_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_organisation_id,invoice_no),
  UNIQUE(claimed_school_id)
);
CREATE TABLE IF NOT EXISTS saas_school_order_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_organisation_id uuid NOT NULL REFERENCES organisations(id),
  order_id uuid NOT NULL REFERENCES saas_school_orders(id),
  amount numeric(14,2) NOT NULL CHECK(amount>0),
  currency char(3) NOT NULL,
  payment_method varchar(40) NOT NULL,
  provider_reference varchar(160),
  idempotency_key uuid,
  recorded_by uuid REFERENCES users(id),
  paid_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_organisation_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS saas_school_orders_provider_idx ON saas_school_orders(provider_organisation_id,created_at DESC);
CREATE INDEX IF NOT EXISTS saas_school_order_payments_order_idx ON saas_school_order_payments(order_id,paid_at);
ALTER TABLE saas_subscription_payments ADD COLUMN IF NOT EXISTS idempotency_key uuid;
CREATE UNIQUE INDEX IF NOT EXISTS saas_subscription_payments_idempotency_idx
  ON saas_subscription_payments(provider_organisation_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
