-- 0012: fila de saida (outbox) das chamadas ao Asaas.
--
-- O problema que a tabela resolve: criar a parcela e pedir a cobranca nao cabem na mesma transacao
-- quando o segundo passo e um POST HTTP. Ou o provedor esta fora do ar e a parcela fica sem
-- cobranca, ou a transacao sofre rollback depois do envio e a cobranca fica orfa no Asaas sem
-- parcela aqui. Com a fila dentro do banco, as duas escritas fecham no mesmo COMMIT: a intencao de
-- cobrar nasce junto com a parcela, e o envio vira trabalho de um laco com estado persistido.
-- Desenho completo em docs/OUTBOX_DESIGN.md (secoes 3 a 8).
--
-- As escolhas que o DDL carrega:
--   * `dedupe_key` UNIQUE por intencao (`asaas.charge.create:<installment_id>`): o POST repetido do
--     usuario vira ON CONFLICT DO NOTHING, e nao duas cobrancas;
--   * `environment` copiado na linha: o laco so pega o ambiente configurado, entao uma linha de
--     sandbox nunca sai com a chave de producao;
--   * `payload` e snapshot (valor e vencimento congelados): editar a parcela depois nao muda
--     silenciosamente uma cobranca ja pedida;
--   * `attempts` incrementa no claim, nao no fim: processo morto no meio da chamada ja consumiu a
--     tentativa, senao o laco tenta para sempre;
--   * `available_at` e o unico relogio, sempre do banco, com indice parcial para os prontos e outro
--     para o reaper de lease vencido (SIGKILL no meio de um envio nao deixa a linha travada).
--
-- `topic` sai com CHECK fechado de proposito: e o contrato que o consumidor precisa implementar, e
-- topic novo custa uma migration (expand) em vez de aceitar string arbitraria numa fila que move
-- dinheiro.

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL CHECK (topic IN ('asaas.customer.create', 'asaas.charge.create')),
  dedupe_key text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'dead')),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts int NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  correlation_id text,
  entity_type text,
  entity_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_dedupe_idx ON outbox_events (dedupe_key);
CREATE INDEX IF NOT EXISTS outbox_events_ready_idx ON outbox_events (available_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS outbox_events_lease_idx ON outbox_events (locked_at) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS outbox_events_entity_idx ON outbox_events (entity_type, entity_id);
