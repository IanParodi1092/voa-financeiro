# Outbox de integracao e worker em processo

Este documento existe **antes** do codigo. Ele fixa o contrato do outbox (tabela, claim, backoff,
idempotencia, ciclo de vida) para que o cliente Asaas seja escrito contra uma fila cujo
comportamento ja esta definido - e nao o contrario.

O que existe hoje (2026-10-27): `asaas_customers`, `asaas_charges` e `asaas_events` (migration 0005), o
webhook que grava o evento cru e responde 202 (`apps/api/src/routes/ops.ts`) e **a fila de saida
inteira** - tabela `outbox_events` (0012), `enqueueOutbox`, claim, worker em processo, cliente Asaas e
os dois endpoints de operacao (secoes 14 e 17).

O que ainda nao existe: nenhum produtor enfileira (depende da decisao 1 da secao 15) e nao ha
consumidor de `asaas_events` - nenhuma linha recebe `processed_at`.

O nome `outbox_events` e o do `.azure/project-plan.md` (linha 69), e o worker no mesmo processo
tambem (linha 33: "jobs de retry e sincronizacao devem poder rodar no mesmo processo inicialmente
e ser extraidos para worker no VPS quando a carga exigir"). Seguir o plano agora evita renomear
tabela depois.

## 1. Problema e escopo

Uma cobranca nasce de uma parcela (`installments` -> `asaas_charges` -> `payments`). A chamada
HTTP ao Asaas nao pode acontecer dentro da transacao que cria a parcela: o provedor pode levar
segundos, pode estar fora do ar, e um rollback depois do efeito externo deixa cobranca orfa no
Asaas sem parcela no banco. Tambem nao pode ser "dispare e esqueca": precisa de retry com estado,
e o estado do retry precisa estar persistido antes do primeiro envio.

Escopo da primeira entrega:

- **saida**: criar cliente Asaas (`asaas.customer.create`), criar cobranca (`asaas.charge.create`);
- **entrada**: consumir `asaas_events` e aplicar status em `asaas_charges`/`payments`/`retention_ledger`;
- **operacao**: ver a fila e reenfileirar uma linha morta.

Fora de escopo (primeira entrega):

- fila de comunicacao (ChatGuru/e-mail). Usa a mesma tabela depois, com outro `topic`, mas o
  contrato e definido com o Asaas primeiro porque e ele que move dinheiro;
- worker em processo separado. O claim nasce pronto para dois processos, mas a extracao so se
  justifica quando a carga exigir;
- tela de fila no web. `GET /api/v1/ops/outbox` (secao 11) basta para operar.

## 2. Decisao: tabela no Postgres e worker no processo da API

1. **Atomicidade.** Enfileirar no mesmo `COMMIT` que cria a parcela e o unico jeito de garantir
   "existe parcela, existe intencao de cobrar" sem 2PC. Um broker externo publicado dentro da
   transacao do Postgres nao e atomico: ou o commit falha e a mensagem ja saiu, ou a mensagem
   falha e a parcela existe sem cobranca.
2. **Volume.** O volume e de parcelas por dia, nao de eventos por segundo. Um `SELECT` indexado a
   cada 2s custa menos (em dinheiro e em superficie de falha) que operar Redis/SQS e o servico de
   producao do broker.
3. **`FOR UPDATE SKIP LOCKED`** (Postgres 9.5+) da o claim correto - dois workers nao pegam a
   mesma linha - sem lock distribuido e sem dependencia nova.
4. **Um banco so.** `asaas_charges.external_id UNIQUE` e a garantia final, e ela mora no mesmo
   banco que a fila: a conciliacao (secao 8) e uma consulta local.

Custo aceito: a fila compete pelo pool da API. Como o claim e transacao curta e o HTTP acontece
fora dela (secao 6), o worker usa no maximo 1 conexao por vez, contra `max: 10` em
`apps/api/src/db/pool.ts`.

## 3. Modelo de dados (`0012_outbox_events.sql`)

Segue as convencoes das migrations existentes: `gen_random_uuid()`, `timestamptz NOT NULL DEFAULT
now()`, `CHECK` explicito, `IF NOT EXISTS` e indice parcial para a consulta de pendentes (mesmo
padrao de `asaas_events_pending_idx`, na 0005).

```sql
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
```

Decisoes dentro do DDL:

- **`topic` com `CHECK`** em vez de `text` livre. O `CHECK` e o contrato que o consumidor precisa
  implementar; topic novo custa uma migration (expand), o que e desejavel - forca revisao em vez
  de aceitar string arbitraria na fila que move dinheiro.
- **`dedupe_key` UNIQUE**: reenvio do mesmo `POST` (usuario clica duas vezes, cliente HTTP repete)
  vira `ON CONFLICT DO NOTHING`. A chave e por intencao, nunca `randomUUID()`:
  `asaas.charge.create:<installment_id>` e `asaas.customer.create:<customer_id>`.
- **`environment` copiado no enfileiramento**, e o worker so pega linhas do ambiente configurado.
  E o que impede uma linha de sandbox ser enviada com a chave de producao (regra do plano: "nunca
  promover dados de sandbox para producao sem mapeamento explicito").
- **`payload` e snapshot**, nao referencia. Valor, vencimento e cliente vao congelados, para que
  editar a parcela depois nao mude silenciosamente uma cobranca ja pedida. Corrigir exige uma
  mensagem nova (topic de update), nunca editar a linha da fila.
- **`max_attempts` por linha**, copiado do config no enfileiramento. Mudar o default do config nao
  ressuscita linha morta nem encurta a vida de linha em voo.
- **`correlation_id`** carrega o `request.id` do Fastify (o mesmo devolvido em `x-correlation-id`)
  para ligar requisicao HTTP, linha da fila e `audit_logs` num so fio.
- **`entity_type`/`entity_id`** apontam para o agregado dono (`installments`, `customers`), com
  `uuid`, para que `POST /api/v1/ops/outbox/:id/retry` reconstrua o contexto.

## 4. Enfileirar dentro da transacao do produtor

```ts
export type OutboxTopic = 'asaas.customer.create' | 'asaas.charge.create';

export interface OutboxMessage {
  topic: OutboxTopic;
  dedupeKey: string;
  payload: Record<string, unknown>;
  entity: { type: string; id: string };
  correlationId: string;
}

/** Recebe `PoolClient`, nunca `Pool`: enfileirar fora de transacao e o bug que o tipo impede. */
export async function enqueueOutbox(
  client: PoolClient,
  message: OutboxMessage,
  options: { environment: 'sandbox' | 'production'; maxAttempts: number }
): Promise<void>;
```

```sql
INSERT INTO outbox_events (topic, dedupe_key, environment, payload, entity_type, entity_id, correlation_id, max_attempts)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (dedupe_key) DO NOTHING
```

Primeiro produtor: `POST /api/v1/installments` (`apps/api/src/routes/finance.ts:75`). Hoje ele faz
um `pool.query` solto; passa a abrir transacao explicita (`pool.connect()` -> `BEGIN` ->
`INSERT installments` -> `enqueueOutbox` -> `COMMIT`) e a chamar `worker.wake()` depois do commit.
O `wake` e otimizacao: se ele nunca for chamado, o poll de 2s resolve.

Efeito colateral desejado: com o enfileiramento dentro do `BEGIN`, a carga de parcelas do legado
tambem nao gera cobranca em lote. A carga continua sem enfileirar - decidir "cobrar 15.535
parcelas historicas" e decisao de negocio, nao efeito de importacao (ver secao 15, item 1).

## 5. Claim

Uma unica instrucao, executada numa transacao curta que **nao** envolve HTTP:

```sql
WITH claimed AS (
  SELECT id FROM outbox_events
   WHERE status = 'pending'
     AND available_at <= now()
     AND environment = $1
   ORDER BY available_at
   FOR UPDATE SKIP LOCKED
   LIMIT $2
)
UPDATE outbox_events m
   SET status = 'processing', locked_at = now(), locked_by = $3,
       attempts = m.attempts + 1, updated_at = now()
  FROM claimed
 WHERE m.id = claimed.id
RETURNING m.id, m.topic, m.payload, m.attempts, m.max_attempts, m.dedupe_key,
          m.entity_type, m.entity_id, m.correlation_id;
```

`attempts` incrementa no claim, nao no fim: se o processo morrer no meio da chamada, a tentativa
ja foi contada e o laco nao tenta para sempre. `now()` e do banco, nunca do processo - dois
processos com relogios diferentes nao brigam por `available_at`.

**Reaper de lease**: no boot e a cada ciclo, `status = 'processing' AND locked_at < now() -
OUTBOX_LEASE_TIMEOUT_MS` volta para `pending` (mantendo `attempts`) com `last_error =
'lease expired'`. Sem isso, um `SIGKILL` no meio de um envio deixa a linha travada para sempre.

## 6. Execucao: transacao curta, HTTP fora dela

```
claim (transacao curta) -> handler HTTP (fora de transacao) -> finish (transacao curta)
```

Nunca segurar transacao aberta durante I/O de rede: cada transacao aberta ocupa uma das 10
conexoes do pool, e um Asaas lento (timeout de 30s) com batch de 5 deixaria a API sem conexao.
A consequencia e **at-least-once**: entre o efeito externo e o `UPDATE ... status = 'done'` existe
uma janela em que o processo pode morrer. Por isso a secao 8.

O `finish` grava, no mesmo `UPDATE`, o resultado e o `audit_logs` (`outbox.done` / `outbox.failed`)
pelo mesmo padrao de `recordAudit` (`apps/api/src/audit.ts`): falha de auditoria nao derruba o
processamento, so vira `warn`.

## 7. Falha: classificada, com backoff no banco

Retry cego em 400 transforma erro de dado em ruido; nao tentar em 429 perde dinheiro. A regra:

| Resultado da chamada | Acao |
| --- | --- |
| 2xx | `done`, `completed_at = now()` |
| 400, 422 | `dead` imediato (payload invalido: retry nao conserta) |
| 401, 403 | `dead` + `log.error` (chave errada ou sem permissao) |
| 404 em update/consulta | `dead` (o recurso nao existe no provedor) |
| 409 | `dead` + conciliacao manual (conflito de estado nao e transitorio) |
| 429 | retry, respeitando `Retry-After` quando vier |
| 5xx, timeout, `ECONNRESET` | retry com backoff |
| erro de programacao (`TypeError`, JSON invalido no payload) | `dead` (o mesmo codigo falharia sempre) |
| infraestrutura local (banco fora, `ECONNREFUSED`, classe `08` do Postgres) | retry, nao ambiguo |

```sql
-- retry
UPDATE outbox_events
   SET status = 'pending',
       available_at = now() + make_interval(secs => $2),
       last_error = $3, locked_at = NULL, locked_by = NULL, updated_at = now()
 WHERE id = $1
-- teto
--   $2 = least(2 ^ (attempts - 1) * 5, 900) * (0.8 + random() * 0.4)
-- quando attempts >= max_attempts: status = 'dead', audit 'outbox.dead'
```

`5s, 10s, 20s, 40s, 80s, 160s, 320s, 640s` (teto de 15 min) e 8 tentativas cobrem ~21 min de
provedor fora do ar. O jitter de +-20% existe para o caso de o lote inteiro falhar junto (Asaas
retornando 503): sem ele, todas as linhas voltam ao mesmo tempo e batem no provedor em sincronia.

O `now()` e do banco, entao `available_at` nao depende do relogio do processo. So a **duracao** vem
do processo, de `retryDelaySeconds` (`apps/api/src/domain/outbox.ts`), que e onde o jitter tem teste
unitario - calcular no SQL deixaria a formula sem cobertura. `Retry-After` do provedor, quando vem,
vence o backoff calculado.

## 8. Idempotencia e conciliacao

O ponto mais delicado do desenho. Duas garantias diferentes:

1. **Local, ja resolvida**: `dedupe_key` UNIQUE + `ON CONFLICT DO NOTHING` faz com que enfileirar
   duas vezes a mesma intencao produza uma linha. Um `POST` repetido do usuario nao gera duas
   cobrancas.
2. **Externa, depende do provedor**: um `POST` que saiu e cujo resultado se perdeu (timeout no meio
   da resposta) pode ter criado a cobranca mesmo assim. Reenviar cria a segunda. O
   `asaas_charges.external_id UNIQUE` **nao** protege disso - os dois envios voltam com ids
   diferentes, e o banco aceita os dois.

Regra obrigatoria para o worker (implementada no handler, nao no cliente HTTP):

- toda mensagem envia `externalReference = dedupeKey` no corpo;
- em timeout/5xx **sem corpo de resposta** (resultado ambiguo), o retry **nao** reenvia as cegas:
  antes faz `GET` filtrando por `externalReference`; se existir, adota o `external_id` e marca
  `done` com `last_error = 'recovered by reconciliation'`;
- se o Asaas oferecer header/parametro de idempotencia para POST de cobranca (verificar na
  documentacao antes de implementar), usar como defesa em profundidade e manter a conciliacao como
  rede de seguranca.

`payments_external_idx` (UNIQUE em `source, external_id`, migration 0004) ja da a mesma protecao no
lado do pagamento recebido: um webhook repetido nao cria dois pagamentos.

## 9. Entrada: consumir `asaas_events`

O webhook ja deduplica por `external_event_id` no `INSERT ... ON CONFLICT DO NOTHING`
(`apps/api/src/routes/ops.ts:36`), entao a tabela nao recebe o mesmo evento duas vezes. Falta o
consumidor:

- claim igual ao da secao 5, sobre `processed_at IS NULL AND failed_at IS NULL` (usa o indice
  parcial que ja existe);
- `WEBHOOK_RETRY_LIMIT` (declarado em `apps/api/src/config.ts`, default 5, **sem consumidor hoje**)
  vira o teto de tentativas; no teto grava `failed_at` + `failure_reason`;
- handlers aplicam **estado**, nunca incrementam: `paid` chega uma vez e reaplica o mesmo
  resultado. Um crash entre "apliquei" e "marquei processado" reexecuta o evento, e isso precisa
  ser inofensivo;
- `retention_ledger` nao tem unicidade por parcela, entao o lancamento entra com
  `INSERT ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM retention_ledger WHERE payment_id = $1 AND
  entry_type = $2)` dentro da transacao do handler (ou um indice unico parcial, decisao 4 da secao
  15);
- ordem fora de sequencia: o handler so avanca estado (`pending -> paid -> refunded`), e evento
  mais antigo que o estado atual e aplicado como no-op com `processed_at` preenchido e log
  `asaas.event.stale`. Sem isso, um `PAYMENT_RECEIVED` atrasado poderia reabrir parcela ja
  estornada.

## 10. Ciclo de vida no processo

Duas decisoes de lugar, ambas com consequencia pratica:

**1. O worker nao nasce em `buildApp`.** `buildApp` e o que os testes usam com `app.inject`
(`apps/api/src/app.integration.test.ts:74`), e o schema descartavel e removido no `afterAll`. Um
laco iniciado dentro de `buildApp` continuaria consultando um schema que nao existe mais, e o
`max: 4` do pool de teste passaria a ser disputado por um laco invisivel. O worker sobe em
`apps/api/src/server.ts`, que e o arquivo do processo.

**2. A ordem de encerramento muda.** Hoje `server.ts` faz `app.close()` e `pool.end()`. Com um
worker, `pool.end()` enquanto ha um `SELECT` em voo produz `Cannot use a pool after calling end on
the pool` - e uma promise rejeitada sem `catch` derruba o processo no Node 22. A ordem passa a ser:
parar o worker, esperar o ciclo atual terminar, `app.close()`, `pool.end()`.

```ts
export interface OutboxWorker {
  /** Falso quando o laco nao roda (desligado por config ou sem chave do Asaas). */
  enabled: boolean;
  /** Acorda o laco agora (chamado depois do COMMIT de quem enfileirou). */
  wake(): void;
  /** Para o laco e espera o ciclo em andamento, no maximo `timeoutMs`. */
  stop(options?: { timeoutMs?: number }): Promise<void>;
}

export function startOutboxWorker(options: {
  pool: Pool;
  logger: FastifyBaseLogger;
  /** Subconjunto do `AppConfig` que o laco usa; `server.ts` faz o mapeamento. */
  settings: {
    environment: OutboxEnvironment;
    pollIntervalMs: number;
    batchSize: number;
    leaseTimeoutMs: number;
  };
  enabled: boolean; // OUTBOX_WORKER_ENABLED
  asaas?: AsaasClient; // sem cliente o laco nao roda: a fila enche e nada sai
  workerId?: string; // hostname:pid, gravado em locked_by
}): OutboxWorker;
```

O laco recebe `settings`, e nao o `AppConfig` inteiro, de proposito: o teste monta um laco com
`pollIntervalMs: 10` sem inventar um ambiente completo, e o tipo mostra exatamente quais numeros o
worker usa (o `OUTBOX_MAX_ATTEMPTS` fica com o **produtor**, que o copia para a linha).

O laco usa `setTimeout` recursivo, nao `setInterval`: com `setInterval`, um ciclo lento (Asaas com
latencia alta) empilha ciclos concorrentes e o paralelismo efetivo deixa de ser 1. Cada ciclo:
reaper -> claim de ate `OUTBOX_BATCH_SIZE` -> processa em serie -> dorme
`OUTBOX_POLL_INTERVAL_MS` (ou menos, se `wake()` foi chamado). Concorrencia 1 e proposital: o
gargalo real e o provedor, e um `batch` pequeno mantem o custo de conexao previsivel.

`OUTBOX_WORKER_ENABLED=false` desliga o laco sem desligar o enfileiramento - util para subir a API
local sem chave do Asaas (as linhas ficam `pending`, visiveis em `/api/v1/ops/outbox`).

## 11. Observabilidade e operacao

Log de cada ciclo/tentativa, com os campos que ligam a historia:

```json
{ "outboxId": "...", "topic": "asaas.charge.create", "attempt": 2, "maxAttempts": 8,
  "correlationId": "<request.id do POST que criou a parcela>", "durationMs": 431,
  "outcome": "retry", "retryInSeconds": 20 }
```

Dois endpoints, ambos em `routes/ops.ts` (modulo de infraestrutura, sem regra de negocio):

- `GET /api/v1/ops/outbox` - `requirePermission('read')`. Resumo:
  `counts` por `status`, `oldestPendingAgeSeconds`, `oldestProcessingAgeSeconds` e as 10 linhas
  `dead` mais recentes (`id`, `topic`, `entityType`, `entityId`, `attempts`, `lastError`,
  `updatedAt`). O sinal de alarme e `oldestPendingAgeSeconds`: fila com pendente velho significa
  worker parado ou provedor recusando tudo - `counts` sozinho nao diferencia.
- `POST /api/v1/ops/outbox/:id/retry` - `requirePermission('audit')` (hoje efetivamente admin).
  Volta a linha para `pending` com `attempts = 0`, `available_at = now()`, `last_error` preservado
  como `previous_error` no `audit_logs`. So aceita linha `dead`; `pending`/`processing` respondem
  `409 OUTBOX_NOT_DEAD`, para nao criar duas entregas concorrentes.

`audit_logs` recebe uma linha por transicao terminal (`outbox.done`, `outbox.dead`,
`outbox.retried`), com `entityType`/`entityId` do agregado dono. E o que permite responder "por que
esta parcela nao tem cobranca?" olhando `GET /api/v1/audit-logs` (rota ja existente, permissao
`audit`).

Retencao: o laco chama `purgeDoneOutbox` uma vez por hora (`PURGE_INTERVAL_MS` em
`outbox/worker.ts`, primeira chamada no primeiro ciclo) e apaga ate 1.000 linhas `done` por vez com
`completed_at` mais antigo que `OUTBOX_RETENTION_DAYS`. A falha do `DELETE` vira log
`outbox purge failed` e **nao** impede o envio das mensagens daquele ciclo; quando ha linha removida,
o ciclo reporta `purged` junto de `claimed`/`done`/`retried`. O historico de uma mensagem concluida
continua em `audit_logs` (`outbox.done`), que nao e expurgado por essa rotina.

## 12. Configuracao

Adicoes ao `environmentSchema` de `apps/api/src/config.ts`, no mesmo estilo (`z.coerce.number`,
`booleanish`), e ao `.env.example`:

```ts
ASAAS_API_URL: z.string().url().default('https://api-sandbox.asaas.com/v3'), // plano, linha 154
ASAAS_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
OUTBOX_WORKER_ENABLED: booleanish(true),
OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(50).default(5),
OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
OUTBOX_LEASE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
OUTBOX_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(90)
```

`ASAAS_API_KEY` e opcional pelo mesmo motivo que `ASAAS_WEBHOOK_TOKEN` ja e: sem ela a API sobe e o
worker registra `asaas client not configured` e nao pega nada. Webhook e worker compartilham
`ASAAS_ENVIRONMENT`, entao uma linha nasce e termina no mesmo ambiente.

## 13. Plano de testes

**Unitarios** (`vitest`, sem banco), em `apps/api/src/domain/outbox.test.ts`:

- progressao `5s..640s` com teto de 900s, jitter dentro de +-20% e `attempts` invalido recusado;
- a tabela da secao 7 inteira: `400/401/403/404/409/422` -> `dead`, `429` com e sem `Retry-After`,
  `408/425/500/502/503` -> retry, `504` e timeout sem `status` -> retry **ambiguo**, `ECONNREFUSED` e
  classe `08` -> retry nao ambiguo, `23505` -> `dead`;
- `dedupeKey` estavel por entidade e `topic` fora da lista fechada recusado.

**Integracao** (`apps/api/src/outbox/outbox.integration.test.ts`), reaproveitando o harness de
`app.integration.test.ts` (schema temporario, `TEST_DATABASE_URL`, `applyMigrations`):

1. enfileirar dentro de transacao que sofre `ROLLBACK` -> nenhuma linha (prova o enfileiramento
   transacional, que e a razao de o outbox existir);
2. mesma `dedupeKey` duas vezes -> 1 linha, e a segunda chamada devolve `false`;
3. fake que responde `503` uma vez e depois 201 -> `attempts = 2`, `done`, `completed_at` preenchido,
   e a tentativa 2 consulta o provedor antes de reenviar;
4. fake que responde `400` -> `dead` na primeira tentativa, com um unico POST;
5. timeout com a cobranca ja existente no provedor -> adota o `externalId`, grava
   `last_error = 'recovered by reconciliation'` e **nao** faz segundo POST;
6. lease vencido: reaper devolve para `pending` com `last_error = 'lease expired'` e `attempts`
   preservado, e o ciclo seguinte conclui;
7. dois ciclos concorrentes com batch 5 sobre 5 linhas -> cada `dedupeKey` processada uma vez
   (prova do `SKIP LOCKED`);
8. `GET /api/v1/ops/outbox` (resumo, 401 sem token) e `POST .../:id/retry`: `dead` -> 200 e `pending`
   com `attempts = 0`, `pending` -> 409, uuid inexistente -> 404, id invalido -> 400 antes de tocar o
   banco, `viewer` -> 403, e `audit_logs` guardando o `previousError`.
9. expurgo: `done` com `completed_at` mais antigo que a retencao sai, `done` recente / `pending` /
   `dead` ficam, e o ciclo sem `purgeDone` nao apaga nada (expurgo nao e efeito colateral do poll).

O `AsaasClient` e uma interface injetada; **nenhum teste toca a rede**. O fake (`FakeAsaasClient`) mora
no proprio arquivo de teste e agenda falha por `externalReference` - assim um cenario nao consome a
falha do outro.

## 14. Sequencia de implementacao

Cada passo e um commit verde (typecheck + `npm test` + `npm run test:integration`). Os passos 1-6
estao feitos; o 7 e o 8 continuam pendentes por decisao de negocio (secao 15).

1. **feito** - `apps/api/migrations/0012_outbox_events.sql`: DDL da secao 3. Nada le a tabela ainda.
2. **feito** - `apps/api/src/domain/outbox.ts` + `domain/outbox.test.ts` (backoff, classificacao,
   `dedupeKey`). As regras puras ficaram num modulo so, e nao em `outbox/backoff.ts` +
   `outbox/classify.ts`, para seguir a camada que o repositorio ja usa: `domain/` e puro e testado
   sem banco, `db/` e SQL.
3. **feito** - `apps/api/src/db/outbox.ts` (`enqueueOutbox`, claim, finish, reaper, resumo, retry) e
   `apps/api/src/outbox/worker.ts` (`runOutboxCycle`, `startOutboxWorker`). O desenho previa um
   worker sem cliente neste passo; na pratica ele nasceu junto com o cliente (passo 4), porque um
   handler que so marca `dead` nao exercita nada.
4. **feito** - `apps/api/src/integrations/asaas-client.ts`: interface + implementacao com `fetch`,
   `AbortSignal.timeout`, `externalReference` e `access_token` no header. `apps/api/src/outbox/handlers.ts`
   traduz cada topic em chamada ao provedor + escrita local (`asaas_customers`, `asaas_charges`) com
   `ON CONFLICT` que reaplica o mesmo estado.
5. **feito** - `apps/api/src/config.ts` (`ASAAS_API_URL`, `ASAAS_API_KEY`, `OUTBOX_*`), `.env.example`
   e `server.ts` (start/stop na ordem da secao 10).
6. **feito** - `routes/ops.ts`: `GET /api/v1/ops/outbox`, `POST /api/v1/ops/outbox/:id/retry`, com
   `apps/api/src/outbox/outbox.integration.test.ts`; `docs/API_ROUTES.md` ganhou as duas rotas.
7. Produtor: `POST /api/v1/installments` passa a abrir transacao e enfileirar (secao 15, item 1).
8. `apps/api/src/outbox/events.ts`: consumidor de `asaas_events` (secao 9, secao 15, item 4).
9. **feito** - retencao: `purgeDoneOutbox` (`db/outbox.ts`), `0013_outbox_retention.sql`,
   `OUTBOX_RETENTION_DAYS` e o expurgo horario no laco (secao 15, item 6). Saiu antes do passo 7
   porque nao depende da decisao de negocio.

Os passos 1-6 e 9 nao dependem de chave do Asaas; o 7 depende de decisao de negocio (secao 15,
item 1).

## 15. Decisoes pendentes (bloqueiam a implementacao, nao o desenho)

1. **Quem e o primeiro produtor?** `POST /api/v1/installments` (parcela nova cria cobranca
   automaticamente) ou uma acao explicita de "gerar cobranca" sobre a parcela existente? A segunda
   e mais segura para operacao financeira e nao cobra retroativo por acidente; a primeira e menos
   clique. Nenhuma das duas cobra as 15.535 parcelas do legado sem uma acao deliberada.
2. **4xx vira `dead` imediato** (tabela da secao 7). Existe caso de 400 transitorio nesse provedor?
3. **Granularidade do `CHECK` de `topic`** - **resolvido**: lista fechada mantida. Um topic novo
   custa uma migration (expand), o que forca revisao em vez de aceitar string arbitraria na fila que
   move dinheiro.
4. **`retention_ledger`**: indice unico parcial em `(payment_id, entry_type)` ou checagem
   `WHERE NOT EXISTS` no handler? O indice e mais forte, mas exige migration e pode conflitar com
   mais de um lancamento legitimo para o mesmo pagamento.
5. **Idempotencia do Asaas** - **resolvido (2026-10-27)**: nao existe chave/header de idempotencia
   no POST de cobranca. A referencia de `POST /v3/payments` lista `customer`, `billingType`, `value`,
   `dueDate`, `description`, `externalReference`, `installmentCount`... e nenhum header de
   idempotencia; a pagina "Cobranca duplicada apos retry sem idempotencia"
   (`https://docs.asaas.com/docs/cobrança-duplicada-após-retry-sem-idempotência`) recomenda
   literalmente o fluxo da secao 8 - *"registrar a tentativa -> consultar o resultado -> reutilizar o
   ID existente ou criar uma unica vez -> armazenar o resultado"* - e avisa que *"Timeout nao
   significa que a cobranca nao foi criada"* e que *"o `externalReference` pode ajudar a relacionar e
   localizar a cobranca, mas deve ser utilizado junto ao controle interno de retries e
   concorrencia"*. Consequencia: `dedupeKey` como `externalReference` + consulta previa **e** o
   mecanismo, nao uma rede de seguranca opcional - exatamente o que `handlers.ts` faz.
6. **Retencao da fila** - **resolvido (2026-10-27)**: 90 dias por default
   (`OUTBOX_RETENTION_DAYS`), `DELETE` em lote de no maximo 1.000 linhas `done`, uma vez por hora,
   dentro do proprio laco (`purgeDoneOutbox`); particao mensal so se o volume justificar. O indice
   parcial `outbox_events_done_idx` (`0013_outbox_retention.sql`) cobre a busca. `dead` **nao** e
   expurgada por idade: e estado de operacao, e o expurgo dela e `POST /ops/outbox/:id/retry` ou uma
   decisao explicita.

## 16. Riscos e limites conhecidos

- **Pool compartilhado**: o worker usa conexao do mesmo pool da API. Concorrencia 1 mantem o custo
  previsivel hoje; se o volume crescer, a extracao para processo separado (com pool proprio) e a
  proxima alavanca - nao aumentar `OUTBOX_BATCH_SIZE`.
- **`statement_timeout` nao esta configurado** em `createPool`. Uma consulta travada segura conexao
  indefinidamente; vale configurar no pool antes de o worker existir.
- **At-least-once e real**: a secao 8 reduz a duplicata a uma janela estreita, nao a zero. Aceitar
  isso e conciliar e mais barato que perseguir exactly-once entre dois sistemas.
- **Laco envenenado**: um payload que derruba o processo (JSON gigante, OOM) volta como `pending`
  apos o lease e derruba de novo. O teto de `attempts` resolve em 8 ciclos e `last_error` mostra o
  motivo.
- **Duas instancias**: o claim ja suporta, mas ambas precisam do mesmo `OUTBOX_LEASE_TIMEOUT_MS` -
  valores diferentes fazem uma instancia "roubar" o trabalho da outra.
- **Sandbox x producao**: `environment` na linha protege o envio, mas `asaas_customers` e
  `asaas_charges` tem `external_id UNIQUE` global. Um mesmo id nos dois ambientes e improvavel
  (ids do Asaas sao distintos); se acontecer, o `INSERT` falha e a mensagem morre em `dead` -
  comportamento correto (nunca sobrescrever), ainda que barulhento.

## 17. Estado da implementacao

Mapa do que existe (2026-10-27), para o proximo passo nao procurar arquivo por arquivo:

| Camada | Arquivo | Papel |
|---|---|---|
| schema | `apps/api/migrations/0012_outbox_events.sql` | `outbox_events` + 4 indices |
| schema | `apps/api/migrations/0013_outbox_retention.sql` | indice parcial dos `done` para o expurgo |
| regras | `apps/api/src/domain/outbox.ts` | `dedupeKey`, backoff, `classifyFailure`, `ProviderError` |
| SQL | `apps/api/src/db/outbox.ts` | enqueue, claim, done/retry/dead, reaper, expurgo, resumo, retry |
| provedor | `apps/api/src/integrations/asaas-client.ts` | `AsaasClient` + implementacao `fetch` |
| handlers | `apps/api/src/outbox/handlers.ts` | topic -> chamada + `asaas_customers`/`asaas_charges` |
| laco | `apps/api/src/outbox/worker.ts` | `runOutboxCycle`, `startOutboxWorker`, expurgo horario |
| processo | `apps/api/src/server.ts` | start no boot, stop antes de `app.close()` |
| operacao | `apps/api/src/routes/ops.ts` | `GET /ops/outbox`, `POST /ops/outbox/:id/retry` |

Testes: 26 unitarios em `domain/outbox.test.ts` e 9 de integracao em
`outbox/outbox.integration.test.ts` (schema descartavel, fake no lugar do provedor).

O que falta, na ordem em que importa:

1. decidir o primeiro produtor (secao 15, item 1) e ligar `enqueueOutbox` em
   `POST /api/v1/installments`;
2. consumidor de `asaas_events` (secao 9): sem ele o webhook grava e ninguem aplica status.

Resolvidos desde o primeiro mapa: idempotencia do Asaas verificada na documentacao (secao 15, item
5 - nao existe header; a recomendacao oficial e o fluxo da secao 8) e expurgo das linhas `done`
implementado (secao 15, item 6).

Nota de infraestrutura: `applyMigrations` (`apps/api/src/db/run-migrations.ts`) passou a segurar um
`pg_advisory_lock` durante a execucao. Duas execucoes concorrentes - duas instancias subindo juntas,
ou os dois arquivos de teste de integracao em paralelo - colidiam em `CREATE EXTENSION IF NOT EXISTS
pgcrypto`: a extensao e do **banco**, nao do schema, e o `IF NOT EXISTS` nao e atomico entre sessoes.
