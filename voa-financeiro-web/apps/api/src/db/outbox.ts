import type { Pool, PoolClient } from 'pg';
import type { OutboxEnvironment, OutboxMessage, OutboxStatus, OutboxTopic } from '../domain/outbox.js';

/**
 * SQL da fila de saida (`outbox_events`, migration `0012`).
 *
 * Cada funcao aqui e uma instrucao unica - sem transacao longa, sem I/O de rede. A regra que o tipo
 * de `enqueueOutbox` protege: receber `PoolClient` e nunca `Pool`, porque enfileirar fora da
 * transacao do produtor e exatamente o bug que o outbox existe para evitar.
 */

export interface EnqueueOptions {
  /** Copiado na linha: o worker so pega o ambiente configurado. */
  environment: OutboxEnvironment;
  /** Copiado na linha: mudar o default do config nao ressuscita linha morta nem encurta a viva. */
  maxAttempts: number;
}

/**
 * Enfileira a intencao dentro da transacao de quem a produziu.
 *
 * Devolve `true` quando a linha nasceu e `false` quando a `dedupe_key` ja existia - o chamador nao
 * precisa tratar o conflito como erro, e um `POST` repetido do usuario vira uma linha so.
 */
export async function enqueueOutbox(
  client: PoolClient,
  message: OutboxMessage,
  options: EnqueueOptions
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO outbox_events (topic, dedupe_key, environment, payload, entity_type, entity_id, correlation_id, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      message.topic,
      message.dedupeKey,
      options.environment,
      JSON.stringify(message.payload),
      message.entity.type,
      message.entity.id,
      message.correlationId,
      options.maxAttempts
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Linha pronta para ser executada, no formato que o worker consome. */
export interface ClaimedMessage {
  id: string;
  topic: OutboxTopic;
  dedupeKey: string;
  payload: Record<string, unknown>;
  /** Ja incrementado por este claim: `1` na primeira tentativa. */
  attempts: number;
  maxAttempts: number;
  entityType: string | null;
  entityId: string | null;
  correlationId: string | null;
}

/**
 * Pega ate `limit` mensagens prontas e as marca `processing`, numa transacao curta.
 *
 * `FOR UPDATE SKIP LOCKED` e o que permite dois workers sem lock distribuido: o segundo pula a linha
 * que o primeiro trancou em vez de esperar por ela. `attempts` incrementa **aqui**, nao no fim, para
 * um processo que morre no meio da chamada ja ter consumido a tentativa.
 */
export async function claimOutboxBatch(
  pool: Pool,
  options: { environment: OutboxEnvironment; limit: number; workerId: string }
): Promise<ClaimedMessage[]> {
  const result = await pool.query(
    `WITH claimed AS (
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
     RETURNING m.id, m.topic, m.dedupe_key AS "dedupeKey", m.payload, m.attempts,
               m.max_attempts AS "maxAttempts", m.entity_type AS "entityType",
               m.entity_id AS "entityId", m.correlation_id AS "correlationId"`,
    [options.environment, options.limit, options.workerId]
  );
  return result.rows as ClaimedMessage[];
}

/** Terminal feliz. `note` guarda o motivo quando a linha foi recuperada por conciliacao. */
export async function markOutboxDone(pool: Pool, id: string, note?: string): Promise<void> {
  await pool.query(
    `UPDATE outbox_events
        SET status = 'done', completed_at = now(), last_error = COALESCE($2, last_error),
            locked_at = NULL, locked_by = NULL, updated_at = now()
      WHERE id = $1`,
    [id, note ?? null]
  );
}

/**
 * Falha transitoria: volta para `pending` com `available_at` no futuro.
 *
 * `now()` e do banco; so a duracao vem do processo (`retryDelaySeconds`), que e onde o jitter e
 * testado. Dois workers com relogios diferentes nao brigam por `available_at`.
 */
export async function scheduleOutboxRetry(
  pool: Pool,
  id: string,
  options: { delaySeconds: number; reason: string }
): Promise<void> {
  await pool.query(
    `UPDATE outbox_events
        SET status = 'pending', available_at = now() + make_interval(secs => $2), last_error = $3,
            locked_at = NULL, locked_by = NULL, updated_at = now()
      WHERE id = $1`,
    [id, options.delaySeconds, options.reason]
  );
}

/** Terminal triste: `dead` nunca e pego pelo claim; so `POST /ops/outbox/:id/retry` o reabre. */
export async function markOutboxDead(pool: Pool, id: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE outbox_events
        SET status = 'dead', completed_at = now(), last_error = $2,
            locked_at = NULL, locked_by = NULL, updated_at = now()
      WHERE id = $1`,
    [id, reason]
  );
}

export interface LeaseReaperResult {
  /** Linhas que voltaram para `pending` e serao tentadas de novo. */
  released: number;
  /** Linhas que ja gastaram o orcamento de tentativas quando o processo morreu. */
  dead: number;
}

/**
 * Devolve para a fila as linhas trancadas por um processo que morreu no meio do envio.
 *
 * Sem isso um `SIGKILL` deixa a linha em `processing` para sempre: nenhum claim a pega e ela some da
 * operacao, aparecendo so como `oldestProcessingAgeSeconds` crescendo. Roda no boot e a cada ciclo.
 *
 * A linha que ja tinha gastado todas as tentativas vai para `dead`, e nao para `pending`: devolve-la
 * seria entregar a nona tentativa a uma mensagem que provavelmente derruba o processo de novo.
 */
export async function releaseExpiredLeases(
  pool: Pool,
  options: { environment: OutboxEnvironment; timeoutMs: number }
): Promise<LeaseReaperResult> {
  const result = await pool.query<{ status: OutboxStatus }>(
    `UPDATE outbox_events
        SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
            completed_at = CASE WHEN attempts >= max_attempts THEN now() ELSE completed_at END,
            available_at = now(), last_error = 'lease expired',
            locked_at = NULL, locked_by = NULL, updated_at = now()
      WHERE status = 'processing'
        AND locked_at IS NOT NULL
        AND locked_at < now() - make_interval(secs => $1 / 1000.0)
        AND environment = $2
      RETURNING status`,
    [options.timeoutMs, options.environment]
  );
  const dead = result.rows.filter((row) => row.status === 'dead').length;
  return { released: result.rows.length - dead, dead };
}

export type RetryOutcome =
  | {
      status: 'requeued';
      dedupeKey: string;
      entityType: string | null;
      entityId: string | null;
      /** `last_error` da linha morta, preservado em `audit_logs` como `previousError`. */
      previousError: string | null;
    }
  | { status: 'not_found' }
  | { status: 'not_dead'; currentStatus: OutboxStatus };

/**
 * Reabre uma linha `dead`: `attempts = 0`, `available_at = now()`, sem lock.
 *
 * O `WHERE status = 'dead'` do `UPDATE` e a trava: `pending` e `processing` nao entram, entao o
 * endpoint nunca cria uma segunda entrega concorrente para a mesma linha. O `last_error` antigo sai
 * no `RETURNING` (via CTE) para ir ao `audit_logs` antes de a coluna ser limpa.
 */
export async function retryDeadMessage(pool: Pool, id: string): Promise<RetryOutcome> {
  const result = await pool.query<{
    dedupeKey: string;
    entityType: string | null;
    entityId: string | null;
    previousError: string | null;
  }>(
    `WITH previous AS (
       SELECT id, last_error FROM outbox_events WHERE id = $1 AND status = 'dead'
     ), updated AS (
       UPDATE outbox_events m
          SET status = 'pending', attempts = 0, available_at = now(), last_error = NULL,
              completed_at = NULL, locked_at = NULL, locked_by = NULL, updated_at = now()
         FROM previous p
        WHERE m.id = p.id
       RETURNING m.id, m.dedupe_key, m.entity_type, m.entity_id
     )
     SELECT u.dedupe_key AS "dedupeKey", u.entity_type AS "entityType", u.entity_id AS "entityId",
            p.last_error AS "previousError"
       FROM updated u JOIN previous p ON p.id = u.id`,
    [id]
  );
  const row = result.rows[0];
  if (row) return { status: 'requeued', ...row };

  const current = await pool.query<{ status: OutboxStatus }>('SELECT status FROM outbox_events WHERE id = $1', [id]);
  const currentStatus = current.rows[0]?.status;
  if (!currentStatus) return { status: 'not_found' };
  return { status: 'not_dead', currentStatus };
}

export interface OutboxSummary {
  counts: Record<OutboxStatus, number>;
  /** Idade do `pending` mais antigo: e o sinal que `counts` sozinho nao da. */
  oldestPendingAgeSeconds: number | null;
  oldestProcessingAgeSeconds: number | null;
  dead: {
    id: string;
    topic: string;
    entityType: string | null;
    entityId: string | null;
    attempts: number;
    lastError: string | null;
    updatedAt: string;
  }[];
}

/**
 * Resumo de operacao (`GET /api/v1/ops/outbox`): duas consultas de leitura, ambas por indice.
 *
 * Fila com pendente velho significa worker parado ou provedor recusando tudo; so `counts` nao
 * diferencia "acabou de chegar" de "esta preso ha 20 minutos".
 */
export async function outboxSummary(pool: Pool, options: { deadLimit: number }): Promise<OutboxSummary> {
  const counts = await pool.query<{
    pending: number;
    processing: number;
    done: number;
    dead: number;
    oldestPendingAgeSeconds: number | null;
    oldestProcessingAgeSeconds: number | null;
  }>(
    `SELECT count(*) FILTER (WHERE status = 'pending')::int AS "pending",
            count(*) FILTER (WHERE status = 'processing')::int AS "processing",
            count(*) FILTER (WHERE status = 'done')::int AS "done",
            count(*) FILTER (WHERE status = 'dead')::int AS "dead",
            EXTRACT(EPOCH FROM now() - min(created_at) FILTER (WHERE status = 'pending'))::int AS "oldestPendingAgeSeconds",
            EXTRACT(EPOCH FROM now() - min(locked_at) FILTER (WHERE status = 'processing'))::int AS "oldestProcessingAgeSeconds"
       FROM outbox_events`
  );
  const dead = await pool.query(
    `SELECT id, topic, entity_type AS "entityType", entity_id AS "entityId", attempts,
            last_error AS "lastError", updated_at AS "updatedAt"
       FROM outbox_events
      WHERE status = 'dead'
      ORDER BY updated_at DESC
      LIMIT $1`,
    [options.deadLimit]
  );
  const row = counts.rows[0];
  return {
    counts: {
      pending: row?.pending ?? 0,
      processing: row?.processing ?? 0,
      done: row?.done ?? 0,
      dead: row?.dead ?? 0
    },
    oldestPendingAgeSeconds: row?.oldestPendingAgeSeconds ?? null,
    oldestProcessingAgeSeconds: row?.oldestProcessingAgeSeconds ?? null,
    dead: dead.rows as OutboxSummary['dead']
  };
}
