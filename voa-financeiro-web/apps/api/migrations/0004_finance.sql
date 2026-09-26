CREATE TABLE IF NOT EXISTS agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools (id),
  customer_id uuid NOT NULL REFERENCES customers (id),
  student_id uuid REFERENCES students (id),
  reference text,
  total_amount numeric(14, 2) NOT NULL CHECK (total_amount >= 0),
  installments_count integer NOT NULL CHECK (installments_count > 0),
  status text NOT NULL DEFAULT 'active',
  legacy_source text,
  legacy_table text,
  legacy_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT agreements_legacy_key_unique UNIQUE (legacy_source, legacy_table, legacy_id)
);

CREATE TABLE IF NOT EXISTS installments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id uuid NOT NULL REFERENCES agreements (id),
  installment_number integer NOT NULL CHECK (installment_number > 0),
  due_date date NOT NULL,
  original_amount numeric(14, 2) NOT NULL CHECK (original_amount >= 0),
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT installments_number_unique UNIQUE (agreement_id, installment_number)
);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installment_id uuid NOT NULL REFERENCES installments (id),
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  paid_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  source text NOT NULL DEFAULT 'manual',
  external_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agreements_customer_idx ON agreements (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS agreements_school_idx ON agreements (school_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS installments_due_status_idx ON installments (due_date, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS payments_installment_idx ON payments (installment_id);
CREATE UNIQUE INDEX IF NOT EXISTS payments_external_idx ON payments (source, external_id) WHERE external_id IS NOT NULL;
