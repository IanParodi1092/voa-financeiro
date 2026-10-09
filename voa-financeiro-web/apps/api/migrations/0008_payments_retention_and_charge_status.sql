-- 0008: retencao/repasse da parcela e status de cobranca do legado.
--
-- A migration 0007 (tokens de refresh) tomou o numero que estava reservado para este bloco, que
-- estava descrito em docs/MIGRATION_WORKFLOW.md como "o que falta para aplicar". As colunas
-- legadas do `Pagamento_Lista` (status do repasse, datas de aprovacao/programacao/realizacao e a
-- fracao de retencao) nao tinham destino canonico: `payments` ganhou `retained_amount` e
-- `released_amount` na 0005, mas nao o estado nem as datas do repasse. Sem estas colunas o mapa
-- de campos nao podia sair de `review` (lacuna `payments_retention_approval`).
--
-- O status de cobranca do legado (`Pagamento_Banco_Status`) tambem nao tinha destino: o
-- `asaas_charges.status` e NOT NULL e recebe 4.799 linhas vazias e 1 linha com `z` (lixo). Com o
-- DEFAULT explicito o vazio vira `unknown` e a carga o registra como LOAD_VALUE_DEFAULTED no
-- relatorio, em vez de derrubar a linha (lacuna `payments_charge_status`).

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS retention_percentage numeric(5, 4)
    CHECK (retention_percentage IS NULL OR (retention_percentage >= 0 AND retention_percentage <= 1)),
  ADD COLUMN IF NOT EXISTS retention_status text
    CHECK (retention_status IS NULL OR retention_status IN ('pending_approval', 'approved', 'released', 'not_applicable', 'direct_payment')),
  ADD COLUMN IF NOT EXISTS retention_approved_at date,
  ADD COLUMN IF NOT EXISTS retention_scheduled_month text
    CHECK (retention_scheduled_month IS NULL OR retention_scheduled_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ADD COLUMN IF NOT EXISTS retention_released_at date;

CREATE INDEX IF NOT EXISTS payments_retention_status_idx
  ON payments (retention_status) WHERE retention_status IS NOT NULL;

ALTER TABLE asaas_charges ALTER COLUMN status SET DEFAULT 'unknown';
