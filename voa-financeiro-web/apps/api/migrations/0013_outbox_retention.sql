-- 0013: indice da retencao da fila de saida (`docs/OUTBOX_DESIGN.md`, secao 15 item 6).
--
-- O expurgo (`purgeDoneOutbox`) roda uma vez por hora e apaga `done` por `completed_at`. Sem indice o
-- DELETE varre a tabela inteira a cada hora, e `outbox_events` cresce com o volume de parcelas: os
-- indices da 0012 servem ao claim (`pending` por `available_at`), ao reaper (`processing` por
-- `locked_at`) e ao dedupe, nenhum serve para "os `done` mais antigos".
--
-- Parcial em `status = 'done'` porque e a unica fatia que o expurgo le. Manter o indice restrito a ela
-- tambem evita pagar escrita a cada claim/retry, que e o caminho quente.
CREATE INDEX IF NOT EXISTS outbox_events_done_idx ON outbox_events (completed_at) WHERE status = 'done';
