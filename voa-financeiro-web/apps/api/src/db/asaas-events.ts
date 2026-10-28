import type { Pool } from 'pg';

/**
 * SQL do consumidor de `asaas_events` (`docs/ASAAS_EVENT_RULES.md`).
 *
 * O webhook (`routes/ops.ts`) ja grava o evento; aqui ele e reivindicado, aplicado e marcado. Sem
 * transacao longa e sem I/O de rede: o payload ja traz tudo o que o handler precisa.
 *
 * Nao existe `status = 'processing'` como no outbox: `attempts` + `last_attempt_at` fazem o papel de
 * lease. O claim incrementa `attempts` e carimba `last_attempt_at`; a linha so volta a ser elegivel
 * quando o lease vence, e um processo morto no meio libera o evento pelo simples passar do tempo.
 */

export interface ClaimedAsaasEvent {
  id: string;
  /** `evt_...` do provedor; o `UNIQUE` do webhook e o que impede o mesmo evento duas vezes. */
  externalEventId: string;
  eventType: string;
  /** `payment.id` do payload, quando o webhook conseguiu extrair. */
  externalChargeId: string | null;
  payload: Record<string, unknown>;
  /** Ja incrementado por este claim: `1` na primeira tentativa. */
  attempts: number;
}

/**
 * Pega ate `limit` eventos pendentes e incrementa `attempts`.
 *
 * Ordem por `created_at`: evento antigo primeiro, porque o provedor so guarda 14 dias e a fila dele
 * pausa depois de 15 falhas - drenar o atrasado e o que evita perder dinheiro.
 */
export async function claimAsaasEventBatch(
  pool: Pool,
  options: { limit: number; maxAttempts: number; leaseTimeoutMs: number }
): Promise<ClaimedAsaasEvent[]> {
  const result = await pool.query<ClaimedAsaasEvent>(
    `WITH claimed AS (
       SELECT id FROM asaas_events
        WHERE processed_at IS NULL
          AND failed_at IS NULL
          AND attempts < $1
          AND (last_attempt_at IS NULL OR last_attempt_at < now() - make_interval(secs => $3 / 1000.0))
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT $2
     )
     UPDATE asaas_events e
        SET attempts = e.attempts + 1, last_attempt_at = now()
       FROM claimed
      WHERE e.id = claimed.id
     RETURNING e.id, e.external_event_id AS "externalEventId", e.event_type AS "eventType",
               e.external_charge_id AS "externalChargeId", e.payload, e.attempts`,
    [options.maxAttempts, options.limit, options.leaseTimeoutMs]
  );
  return result.rows;
}

/**
 * Terminal feliz: `applied`, `stale`, `ignored` e `orphan` saem do claim e nunca voltam.
 * `failureReason` guarda o motivo quando o desfecho foi `orphan` (cobranca desconhecida).
 */
export async function markAsaasEventProcessed(
  pool: Pool,
  id: string,
  options: { failureReason?: string | null } = {}
): Promise<void> {
  await pool.query(
    `UPDATE asaas_events
        SET processed_at = now(), failure_reason = $2, last_attempt_at = NULL
      WHERE id = $1`,
    [id, options.failureReason ?? null]
  );
}

export interface EventFailureResult {
  /** Verdadeiro quando esta falha gastou a ultima tentativa: a linha vira `failed_at`. */
  exhausted: boolean;
  attempts: number;
}

/**
 * Falha transitoria: mantem o evento pendente e deixa o lease segurar a proxima tentativa.
 *
 * No teto (`attempts >= maxAttempts`) grava `failed_at`, que tira a linha do claim ate um
 * `POST /ops/asaas-events/:id/retry`. Sem isso, um evento que sempre falha ocuparia o lote para
 * sempre e esconderia os eventos novos.
 */
export async function failAsaasEvent(
  pool: Pool,
  id: string,
  options: { reason: string; maxAttempts: number }
): Promise<EventFailureResult> {
  const result = await pool.query<{ exhausted: boolean; attempts: number }>(
    `UPDATE asaas_events
        SET failure_reason = $2,
            failed_at = CASE WHEN attempts >= $3 THEN now() END,
            last_attempt_at = CASE WHEN attempts >= $3 THEN NULL ELSE last_attempt_at END
      WHERE id = $1
     RETURNING failed_at IS NOT NULL AS exhausted, attempts`,
    [id, options.reason, options.maxAttempts]
  );
  const row = result.rows[0];
  return { exhausted: row?.exhausted ?? false, attempts: row?.attempts ?? 0 };
}

export interface AsaasEventsSummary {
  counts: { pending: number; processed: number; failed: number };
  oldestPendingAgeSeconds: number | null;
  failed: {
    id: string;
    eventType: string;
    externalChargeId: string | null;
    attempts: number;
    failureReason: string | null;
    createdAt: string;
  }[];
}

/**
 * Resumo de operacao (`GET /api/v1/ops/asaas-events`), no molde do `outboxSummary`.
 *
 * `oldestPendingAgeSeconds` e o alarme: o provedor guarda o evento por 14 dias e pausa a entrega
 * depois de 15 falhas, entao fila parada aqui vira perda de evento (e de dinheiro) do outro lado.
 */
export async function asaasEventsSummary(pool: Pool, options: { failedLimit: number }): Promise<AsaasEventsSummary> {
  const counts = await pool.query<{
    pending: number;
    processed: number;
    failed: number;
    oldestPendingAgeSeconds: number | null;
  }>(
    `SELECT count(*) FILTER (WHERE processed_at IS NULL AND failed_at IS NULL)::int AS "pending",
            count(*) FILTER (WHERE processed_at IS NOT NULL)::int AS "processed",
            count(*) FILTER (WHERE failed_at IS NOT NULL)::int AS "failed",
            EXTRACT(EPOCH FROM now() - min(created_at) FILTER (WHERE processed_at IS NULL AND failed_at IS NULL))::int
              AS "oldestPendingAgeSeconds"
       FROM asaas_events`
  );
  const failed = await pool.query(
    `SELECT id, event_type AS "eventType", external_charge_id AS "externalChargeId", attempts,
            failure_reason AS "failureReason", created_at AS "createdAt"
       FROM asaas_events
      WHERE failed_at IS NOT NULL
      ORDER BY failed_at DESC
      LIMIT $1`,
    [options.failedLimit]
  );
  const row = counts.rows[0];
  return {
    counts: {
      pending: row?.pending ?? 0,
      processed: row?.processed ?? 0,
      failed: row?.failed ?? 0
    },
    oldestPendingAgeSeconds: row?.oldestPendingAgeSeconds ?? null,
    failed: failed.rows as AsaasEventsSummary['failed']
  };
}

export type RetryEventOutcome =
  | {
      status: 'requeued';
      externalEventId: string;
      eventType: string;
      /** `failure_reason` da linha falhada, preservado no `audit_logs` como `previousError`. */
      previousError: string | null;
    }
  | { status: 'not_found' }
  | { status: 'not_failed'; currentStatus: 'pending' | 'processed' };

/**
 * Reabre um evento `failed_at`: zera `attempts`, limpa `failure_reason` e `last_attempt_at`.
 *
 * O `WHERE failed_at IS NOT NULL` do `UPDATE` e a trava - evento pendente ou ja processado nao entra,
 * entao o endpoint nunca cria duas entregas concorrentes do mesmo evento.
 */
export async function retryFailedAsaasEvent(pool: Pool, id: string): Promise<RetryEventOutcome> {
  const result = await pool.query<{
    externalEventId: string;
    eventType: string;
    previousError: string | null;
  }>(
    `WITH previous AS (
       SELECT id, failure_reason FROM asaas_events WHERE id = $1 AND failed_at IS NOT NULL
     ), updated AS (
       UPDATE asaas_events e
          SET attempts = 0, failed_at = NULL, failure_reason = NULL, last_attempt_at = NULL
         FROM previous p
        WHERE e.id = p.id
       RETURNING e.id, e.external_event_id, e.event_type
     )
     SELECT u.external_event_id AS "externalEventId", u.event_type AS "eventType",
            p.failure_reason AS "previousError"
       FROM updated u JOIN previous p ON p.id = u.id`,
    [id]
  );
  const row = result.rows[0];
  if (row) return { status: 'requeued', ...row };

  const current = await pool.query<{ failed: boolean; processed: boolean }>(
    'SELECT failed_at IS NOT NULL AS failed, processed_at IS NOT NULL AS processed FROM asaas_events WHERE id = $1',
    [id]
  );
  const state = current.rows[0];
  if (!state) return { status: 'not_found' };
  return { status: 'not_failed', currentStatus: state.processed ? 'processed' : 'pending' };
}

