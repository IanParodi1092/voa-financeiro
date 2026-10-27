-- 0010: as tres lacunas de schema que sobraram da classe D da triagem.
--
-- A 0009 fechou os dois `legacy_id` que faltavam em `contacts` e `installments`. As tres lacunas
-- abaixo exigem coluna ou tabela nova e esta migration as resolve somente no schema: nenhuma
-- coluna do dicionario passa a apontar para ca, entao a carga continua identica (as tres colunas
-- de origem seguem em `review` por semantica/politica, nao por falta de destino).
--
-- 1. `agreements.closed_at`: `TBL_PAGAMENTO.Pagamento_DataFechamento` tem 1.497 de 1.572 linhas
--    preenchidas e `agreements` nao tinha onde guardar. A coluna nasce nullable e sem mapeamento
--    porque a semantica ainda esta em revisao: fechamento do acordo (parcelamento encerrado) ou
--    assinatura do contrato? Enquanto isso o valor fica so no payload de staging.
--
-- 2. `student_contacts`: `TBL_ENDTEL` tem 47.562 telefones/e-mails/enderecos de aluno (6.894
--    alunos, 44.764 linhas com aluno resolvido pelo `students.legacy_id`). `contacts` nao serve
--    porque `customer_id` e `NOT NULL` e o contato pertence ao aluno, nao ao cliente pagador.
--    A tabela espelha `contacts` (type/value/is_primary/is_verified + proveniencia legada) e
--    aponta para `students`. Sem mapeamento ainda: 5.988 linhas nao tem tipo nem status e o
--    vinculo de contato exige a mesma decisao de identidade da classe C.
--
-- 3. `users.legacy_*`: `TBL_USER` tem 28 usuarios internos. Sem a chave legada nao ha como casar
--    a conta criada no canonico com a linha do PowerApps. A coluna e so rastreabilidade: a
--    importacao continua presa a politica de credencial (`users.password_hash` e `NOT NULL` e a
--    senha do legado nao migra).

ALTER TABLE agreements
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

CREATE INDEX IF NOT EXISTS agreements_closed_idx
  ON agreements (closed_at) WHERE closed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS student_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  type text NOT NULL,
  value text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  is_verified boolean NOT NULL DEFAULT false,
  legacy_source text,
  legacy_table text,
  legacy_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT student_contacts_legacy_key_unique UNIQUE (legacy_source, legacy_table, legacy_id)
);

CREATE INDEX IF NOT EXISTS student_contacts_student_idx
  ON student_contacts (student_id) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS student_contacts_primary_idx
  ON student_contacts (student_id) WHERE is_primary AND deleted_at IS NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS legacy_source text,
  ADD COLUMN IF NOT EXISTS legacy_table text,
  ADD COLUMN IF NOT EXISTS legacy_id text;

-- Indice unico (e nao constraint) para a migration ser idempotente: `ADD CONSTRAINT` nao aceita
-- `IF NOT EXISTS`. O `ON CONFLICT (legacy_source, legacy_table, legacy_id)` de uma carga futura
-- infere qualquer indice unico equivalente.
CREATE UNIQUE INDEX IF NOT EXISTS users_legacy_key_idx
  ON users (legacy_source, legacy_table, legacy_id);
