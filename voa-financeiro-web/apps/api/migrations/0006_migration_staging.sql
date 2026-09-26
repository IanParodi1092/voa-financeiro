CREATE TABLE IF NOT EXISTS migration_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name text NOT NULL,
  source_hash text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('xlsx', 'csv', 'xml', 'dataverse_export', 'other')),
  status text NOT NULL DEFAULT 'profiled' CHECK (status IN ('profiled', 'staging', 'validated', 'approved', 'committed', 'rolled_back', 'failed')),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_name, source_hash)
);

CREATE TABLE IF NOT EXISTS migration_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES migration_batches (id) ON DELETE CASCADE,
  source_sheet text NOT NULL,
  source_row_number integer NOT NULL CHECK (source_row_number > 0),
  legacy_table text,
  legacy_id text,
  row_hash text NOT NULL,
  payload jsonb NOT NULL,
  normalized_payload jsonb,
  status text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'validated', 'warning', 'error', 'mapped', 'committed', 'ignored')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, source_sheet, source_row_number),
  UNIQUE (batch_id, row_hash)
);

CREATE TABLE IF NOT EXISTS migration_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES migration_batches (id) ON DELETE CASCADE,
  row_id uuid REFERENCES migration_rows (id) ON DELETE CASCADE,
  error_code text NOT NULL,
  severity text NOT NULL DEFAULT 'error' CHECK (severity IN ('warning', 'error', 'blocking')),
  field_name text,
  message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reconciliation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES migration_batches (id) ON DELETE CASCADE,
  entity_name text NOT NULL,
  source_count integer NOT NULL DEFAULT 0 CHECK (source_count >= 0),
  staged_count integer NOT NULL DEFAULT 0 CHECK (staged_count >= 0),
  canonical_count integer NOT NULL DEFAULT 0 CHECK (canonical_count >= 0),
  source_total numeric(16, 2),
  canonical_total numeric(16, 2),
  duplicate_candidates integer NOT NULL DEFAULT 0 CHECK (duplicate_candidates >= 0),
  blocking_errors integer NOT NULL DEFAULT 0 CHECK (blocking_errors >= 0),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, entity_name)
);

CREATE INDEX IF NOT EXISTS migration_rows_batch_status_idx ON migration_rows (batch_id, status);
CREATE INDEX IF NOT EXISTS migration_rows_legacy_idx ON migration_rows (legacy_table, legacy_id);
CREATE INDEX IF NOT EXISTS migration_errors_batch_idx ON migration_errors (batch_id, severity, resolved_at);
CREATE INDEX IF NOT EXISTS reconciliation_batch_idx ON reconciliation_reports (batch_id, entity_name);
