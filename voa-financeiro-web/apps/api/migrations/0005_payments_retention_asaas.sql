CREATE TABLE IF NOT EXISTS retention_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools (id),
  installment_id uuid REFERENCES installments (id),
  payment_id uuid,
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
  entry_type text NOT NULL DEFAULT 'retention',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS retained_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (retained_amount >= 0),
  ADD COLUMN IF NOT EXISTS released_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (released_amount >= 0);

CREATE TABLE IF NOT EXISTS asaas_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL UNIQUE REFERENCES customers (id),
  external_id text NOT NULL UNIQUE,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  last_status text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS asaas_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installment_id uuid REFERENCES installments (id),
  asaas_customer_id uuid NOT NULL REFERENCES asaas_customers (id),
  external_id text NOT NULL UNIQUE,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  billing_type text NOT NULL,
  value numeric(14, 2) NOT NULL CHECK (value >= 0),
  due_date date NOT NULL,
  status text NOT NULL,
  invoice_url text,
  bank_slip_url text,
  pix_qr_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS asaas_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_event_id text NOT NULL UNIQUE,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  event_type text NOT NULL,
  external_charge_id text,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS retention_ledger_school_idx ON retention_ledger (school_id, created_at);
CREATE INDEX IF NOT EXISTS asaas_charges_installment_idx ON asaas_charges (installment_id);
CREATE INDEX IF NOT EXISTS asaas_charges_status_idx ON asaas_charges (status, due_date);
CREATE INDEX IF NOT EXISTS asaas_events_pending_idx ON asaas_events (created_at) WHERE processed_at IS NULL AND failed_at IS NULL;
