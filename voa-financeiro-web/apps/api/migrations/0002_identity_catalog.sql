CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS schools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  trade_name text,
  document_number text,
  status text NOT NULL DEFAULT 'active',
  retention_enabled boolean NOT NULL DEFAULT false,
  retention_target_amount numeric(14, 2),
  legacy_source text,
  legacy_table text,
  legacy_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT schools_retention_target_nonnegative CHECK (retention_target_amount IS NULL OR retention_target_amount >= 0),
  CONSTRAINT schools_legacy_key_unique UNIQUE (legacy_source, legacy_table, legacy_id)
);

CREATE INDEX IF NOT EXISTS schools_document_idx ON schools (document_number);
CREATE INDEX IF NOT EXISTS schools_status_idx ON schools (status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  document_number text,
  email text,
  phone text,
  status text NOT NULL DEFAULT 'active',
  legacy_source text,
  legacy_table text,
  legacy_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT customers_legacy_key_unique UNIQUE (legacy_source, legacy_table, legacy_id)
);

CREATE INDEX IF NOT EXISTS customers_document_idx ON customers (document_number) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS customers_email_idx ON customers (lower(email)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  type text NOT NULL,
  value text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  is_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS contacts_customer_idx ON contacts (customer_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools (id),
  customer_id uuid REFERENCES customers (id),
  full_name text NOT NULL,
  document_number text,
  enrollment_number text,
  status text NOT NULL DEFAULT 'active',
  legacy_source text,
  legacy_table text,
  legacy_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT students_legacy_key_unique UNIQUE (legacy_source, legacy_table, legacy_id)
);

CREATE INDEX IF NOT EXISTS students_school_idx ON students (school_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS students_customer_idx ON students (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS students_document_idx ON students (document_number) WHERE deleted_at IS NULL;
