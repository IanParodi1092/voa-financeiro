-- 0009: rastreabilidade legada de contacts e installments.
--
-- `contacts` (54.782 linhas de TBL_CLIENTEENDTEL, 46.829 carregadas) e `installments`
-- (15.535 linhas de TBL_PAGAMENTO_LISTAGEM, 15.259 carregadas) nasceram sem as colunas
-- `legacy_*`. Hoje a origem de cada linha existe apenas no payload de staging e no UUID
-- deterministico que a carga usa (`uuid5` de `<aba>:<linha>`), entao nem a conciliacao linha a
-- linha com o PowerApps nem um reprocessamento idempotente sabem de onde a linha veio. Era o que
-- prendia as lacunas `contacts_legacy_id` e `installments_legacy_id` (2 colunas em `review`).
--
-- A migration e inerte para a carga: `load_canonical_batch.py` so usa a chave legada quando o
-- dicionario declara `provides_legacy_id_for` para a tabela. Antes de habilitar o provedor, as
-- linhas ja gravadas precisam ser carimbadas por `scripts/backfill_legacy_provenance.py`; sem o
-- carimbo a carga tentaria reinseri-las e o banco recusaria pela chave natural
-- (`installments` por (agreement_id, installment_number)).

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS legacy_source text,
  ADD COLUMN IF NOT EXISTS legacy_table text,
  ADD COLUMN IF NOT EXISTS legacy_id text;

ALTER TABLE installments
  ADD COLUMN IF NOT EXISTS legacy_source text,
  ADD COLUMN IF NOT EXISTS legacy_table text,
  ADD COLUMN IF NOT EXISTS legacy_id text;

-- Indice unico (e nao constraint) para a migration ser idempotente: `ADD CONSTRAINT` nao aceita
-- `IF NOT EXISTS`. O `ON CONFLICT (legacy_source, legacy_table, legacy_id)` da carga infere
-- qualquer indice unico equivalente.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_legacy_key_idx
  ON contacts (legacy_source, legacy_table, legacy_id);

CREATE UNIQUE INDEX IF NOT EXISTS installments_legacy_key_idx
  ON installments (legacy_source, legacy_table, legacy_id);
