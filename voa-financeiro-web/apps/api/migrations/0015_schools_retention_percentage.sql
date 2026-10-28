-- 0015: percentual de retencao por escola (`docs/ASAAS_EVENT_RULES.md`, secao 5).
--
-- A secao 5 deixou a fonte do percentual em aberto: no fluxo legado ele vem da planilha
-- (`Pagamento_Lista` -> `payments.retention_percentage`), mas um pagamento **novo** vindo do Asaas nao
-- passa por planilha nenhuma. Decisao tomada (opcao 1 da secao 5): a regra e da escola.
--
-- Mesmo tipo e mesmo CHECK de `payments.retention_percentage` (`0008`): `numeric(5, 4)` entre 0 e 1
-- (0.15 = 15%). `NULL` significa "escola sem percentual definido" e `retention_enabled` continua sendo
-- o interruptor - o consumidor so lanca retencao com os dois preenchidos, e nunca inventa percentual
-- (secao 5, regra 4): sem numero, o pagamento vira `retention_status = 'not_applicable'`.
--
-- Editavel por `PATCH /api/v1/schools/:id` (`catalog:write`), junto de `retentionEnabled`; a coluna
-- entra em `patch-specs.ts` para o valor nao chegar ao `SET` por fora da allowlist.
--
-- Sem backfill: a coluna nasce `NULL` em toda escola, e `RETENTION_LEDGER_ENABLED=false` mantem o
-- lancamento desligado ate alguem preencher o percentual e virar a chave.
ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS retention_percentage numeric(5, 4)
    CHECK (retention_percentage IS NULL OR (retention_percentage >= 0 AND retention_percentage <= 1));
