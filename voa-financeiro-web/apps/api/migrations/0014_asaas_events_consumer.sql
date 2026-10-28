-- 0014: consumidor de `asaas_events` (docs/ASAAS_EVENT_RULES.md).
--
-- Tres lacunas que o desenho da secao 9 nao cobria e que so aparecem quando o consumidor existe:
--
--   * `attempts`: o teto do `WEBHOOK_RETRY_LIMIT` precisa de contador. Sem coluna, o laco nao
--     distingue "nunca tentou" de "tentou 5 vezes" e um evento que sempre falha fica na fila para
--     sempre. `last_attempt_at` faz o papel de lease: dois processos nao pegam o mesmo evento ao
--     mesmo tempo, e um processo morto no meio libera a linha quando o lease vence.
--   * `retention_ledger (payment_id, entry_type)`: trava do lancamento de retencao (secao 15, item 4).
--     `entry_type` entra na chave porque `retention`, `release` e `reversal` sao lancamentos
--     legitimos do mesmo pagamento.
--
-- Idempotencia de `payments` **nao** precisa de indice novo: `payments_external_idx`
-- (`UNIQUE (source, external_id) WHERE external_id IS NOT NULL`, da `0004`) ja existe e e justamente o
-- alvo do `ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL` do consumidor. Um indice
-- parcial em `(external_id) WHERE source = 'asaas'` seria redundante e ainda quebraria a inferencia do
-- `ON CONFLICT` (o predicado dado nao implica `external_id IS NOT NULL`).
--
-- Pre-flight rodado em `voa_staging` (2026-10-27): 0 duplicados em `retention_ledger (payment_id,
-- entry_type)`, entao o indice entra sem backfill.

ALTER TABLE asaas_events
  ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS retention_ledger_payment_entry_unique
  ON retention_ledger (payment_id, entry_type) WHERE payment_id IS NOT NULL;
