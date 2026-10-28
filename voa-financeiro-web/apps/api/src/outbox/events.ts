import type { FastifyBaseLogger } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import {
  claimAsaasEventBatch,
  failAsaasEvent,
  markAsaasEventProcessed,
  type ClaimedAsaasEvent
} from '../db/asaas-events.js';
import { normalizeChargeStatus, resolveTransition } from '../domain/asaas-events.js';

/**
 * O laco que consome `asaas_events` (passo 8 do `docs/OUTBOX_DESIGN.md`), seguindo a regra escrita em
 * `docs/ASAAS_EVENT_RULES.md`.
 *
 * Diferenca de fundo para o outbox: aqui **o evento ja chegou** e o provedor so guarda 14 dias antes de
 * descartar. Entao o laco nao "entrega" nada, ele aplica estado - e o pior caso de uma falha e
 * `failed_at` visivel na operacao, nunca um evento perdido em silencio.
 *
 * Tres invariantes:
 *
 * 1. **Todo desfecho preenche `processed_at`**, inclusive `stale`, `ignored` e `orphan`: evento que
 *    nao mudou nada ainda foi processado, e devolve-lo a fila so gera calor.
 * 2. **Estado, nunca incremento.** `payments` e `ON CONFLICT (source, external_id)`, `installments`
 *    recebe o estado alvo. Reaplicar o mesmo evento e inofensivo por construcao.
 * 3. **Nada de chamada ao provedor.** O payload ja traz `payment.id`, `status` e `value`.
 */

export interface AsaasEventSettings {
  batchSize: number;
  leaseTimeoutMs: number;
  /** Teto de tentativas (`WEBHOOK_RETRY_LIMIT`). */
  maxAttempts: number;
  /**
   * Liga o lancamento em `retention_ledger` (`RETENTION_LEDGER_ENABLED`, default `false`). Desligado, o
   * consumidor aplica estado e `payments` e nao toca em retencao - e o estado em que o recurso nasce,
   * porque depende de as escolas terem percentual configurado.
   */
  retentionLedgerEnabled: boolean;
}

export interface AsaasEventWorkerDeps {
  pool: Pool;
  logger: FastifyBaseLogger;
}

export interface AsaasEventCycleResult {
  claimed: number;
  applied: number;
  stale: number;
  ignored: number;
  orphan: number;
  retried: number;
  failed: number;
}

const paymentSchema = z
  .object({
    payment: z
      .object({
        id: z.string().trim().min(1),
        status: z.string().trim().min(1).optional(),
        value: z.number().nonnegative().optional(),
        /** Data de pagamento em `paymentDate`, `confirmedDate` ou `clientPaymentDate`. */
        paymentDate: z.string().trim().min(1).optional(),
        confirmedDate: z.string().trim().min(1).optional(),
        clientPaymentDate: z.string().trim().min(1).optional(),
        externalReference: z.string().trim().max(200).optional()
      })
      .passthrough()
  })
  .passthrough();

type PaymentPayload = z.infer<typeof paymentSchema>['payment'];

function parsePayment(message: ClaimedAsaasEvent): PaymentPayload {
  const parsed = paymentSchema.safeParse(message.payload);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`).join('; ');
    throw new Error(`payload invalido: ${details}`);
  }
  return parsed.data.payment;
}

function paidAtOf(payment: PaymentPayload): Date | null {
  const raw = payment.paymentDate ?? payment.confirmedDate ?? payment.clientPaymentDate;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface ChargeRow {
  chargeId: string;
  installmentId: string | null;
  installmentStatus: string | null;
  originalAmount: string | null;
  /** Escola dona da parcela (`installments -> agreements -> schools`), quando a cadeia existe. */
  schoolId: string | null;
  retentionEnabled: boolean | null;
  /** `numeric(5, 4)` chega como string do driver; `null` = escola sem percentual (0015). */
  retentionPercentage: string | null;
}

/** Localiza a cobranca local pela `external_id` do provedor e a parcela ligada a ela. */
async function findCharge(pool: Pool, externalChargeId: string): Promise<ChargeRow | undefined> {
  const result = await pool.query<ChargeRow>(
    `SELECT ac.id AS "chargeId", ac.installment_id AS "installmentId",
            i.status AS "installmentStatus", i.original_amount AS "originalAmount",
            a.school_id AS "schoolId",
            s.retention_enabled AS "retentionEnabled", s.retention_percentage AS "retentionPercentage"
       FROM asaas_charges ac
       LEFT JOIN installments i ON i.id = ac.installment_id
       LEFT JOIN agreements a ON a.id = i.agreement_id
       LEFT JOIN schools s ON s.id = a.school_id
      WHERE ac.external_id = $1`,
    [externalChargeId]
  );
  return result.rows[0];
}

export interface ApplyOutcome {
  /** Motivo quando o lancamento em `payments` nao pode ser gravado (`CHECK amount > 0`). */
  paymentSkipped: string | null;
  /** Motivo quando a retencao nao foi lancada (secao 5, regra 4). `null` e o caso normal. */
  retentionSkipped: string | null;
}

/** Estados de pagamento que confirmam dinheiro: os unicos que lancam retencao (secao 5, regra 1). */
const MONEY_IN_PAYMENT_STATUSES: readonly string[] = ['confirmed', 'paid'];

/**
 * Lancamento no `retention_ledger` (secao 5 de `docs/ASAAS_EVENT_RULES.md`).
 *
 * O percentual vem da **escola** (`schools.retention_percentage`, `0015`), nao do payload: um pagamento
 * novo vindo do Asaas nao passa pela planilha que alimenta `payments.retention_percentage`. Escola sem
 * `retention_enabled` ou sem percentual **nao inventa numero** - o pagamento vira `not_applicable`, que e
 * a regra 4.
 *
 * Idempotencia em duas camadas: `NOT EXISTS` mantem o codigo correto mesmo num banco sem a
 * `retention_ledger_payment_entry_unique` da `0014`, e o `ON CONFLICT DO NOTHING` (sem alvo, entao sem
 * depender da inferencia do indice parcial) absorve a corrida entre dois processos. Todos os valores sao
 * **absolutos**, nunca incrementais: reaplicar o evento reescreve o mesmo numero.
 */
async function applyRetention(
  client: PoolClient,
  row: ChargeRow,
  changes: { chargeStatus: string | null; installmentStatus: string; paymentStatus: string | null },
  paymentId: string,
  amount: number,
  settings: AsaasEventSettings
): Promise<string | null> {
  if (!settings.retentionLedgerEnabled) return null;
  const status = changes.paymentStatus;
  const moneyIn = status !== null && MONEY_IN_PAYMENT_STATUSES.includes(status);
  const refunded = status === 'refunded';
  if (!moneyIn && !refunded) return null;
  if (row.schoolId === null) return 'parcela sem escola (agreement sem school_id)';

  if (refunded) {
    // Regra 3: o estorno depois do lancamento vira `reversal` com o mesmo valor retido.
    await client.query(
      `INSERT INTO retention_ledger (school_id, installment_id, payment_id, amount, entry_type)
       SELECT school_id, installment_id, payment_id, amount, 'reversal'
         FROM retention_ledger
        WHERE payment_id = $1 AND entry_type = 'retention'
          AND NOT EXISTS (SELECT 1 FROM retention_ledger WHERE payment_id = $1 AND entry_type = 'reversal')
       ON CONFLICT DO NOTHING`,
      [paymentId]
    );
    const reverted = await client.query(
      `UPDATE payments SET retained_amount = 0, updated_at = now() WHERE id = $1 AND retained_amount > 0`,
      [paymentId]
    );
    if (reverted.rowCount !== 0) return null;
    // Nada a zerar: ou o estorno ja foi registrado, ou nunca houve retencao lancada. O ledger distingue.
    const posted = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM retention_ledger WHERE payment_id = $1 AND entry_type = 'retention'`,
      [paymentId]
    );
    return (posted.rows[0]?.count ?? 0) === 0 ? 'estorno sem retencao lancada' : null;
  }

  const percentage = row.retentionPercentage === null ? null : Number(row.retentionPercentage);
  if (row.retentionEnabled !== true || percentage === null || !Number.isFinite(percentage) || percentage <= 0) {
    return notApplicable(client, paymentId, row, percentage);
  }

  const retained = Math.round(amount * percentage * 100) / 100;
  if (retained <= 0) {
    await notApplicable(client, paymentId, row, percentage);
    return `retencao calculada igual a zero (${percentage})`;
  }

  await client.query(
    `INSERT INTO retention_ledger (school_id, installment_id, payment_id, amount, entry_type)
     SELECT $1, $2, $3, $4, 'retention'
      WHERE NOT EXISTS (SELECT 1 FROM retention_ledger WHERE payment_id = $3 AND entry_type = 'retention')
     ON CONFLICT DO NOTHING`,
    [row.schoolId, row.installmentId, paymentId, retained]
  );
  // `retained_amount` e o liquido retido (a regra 3 zera no `reversal`); `retention_status` fica como
  // esta, porque `pending_approval`/`approved`/`released` e ciclo de aprovacao humana
  // (`PATCH /api/v1/payments/:id`).
  await client.query(
    `UPDATE payments SET retained_amount = $2, retention_percentage = $3, updated_at = now() WHERE id = $1`,
    [paymentId, retained, percentage]
  );
  return null;
}

/** Regra 4: escola sem regra nao tem lancamento, e o pagamento diz por que. */
async function notApplicable(client: PoolClient, paymentId: string, row: ChargeRow, percentage: number | null): Promise<string | null> {
  await client.query(
    `UPDATE payments SET retention_status = 'not_applicable', updated_at = now() WHERE id = $1 AND retention_status IS NULL`,
    [paymentId]
  );
  if (row.retentionEnabled !== true) return 'escola sem retencao habilitada';
  return percentage === null
    ? 'escola sem percentual de retencao'
    : `percentual sem retencao (${String(row.retentionPercentage)})`;
}

/**
 * Aplica o estado na transacao curta: cobranca, parcela, lancamento e retencao fecham juntos.
 *
 * `ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL` e a chave **que ja existe** desde a
 * `0004` (`payments_external_idx`): reaplicar o evento atualiza o mesmo lancamento em vez de criar um
 * segundo. Nao ha indice novo em `0014` por isso - `(source, external_id)` cobre `asaas` e `manual`.
 *
 * Devolve os motivos quando o lancamento em `payments` nao pode ser gravado (`amount > 0` e `CHECK` da
 * tabela) e quando a retencao nao se aplica. O estado da parcela vale mais que o lancamento: ele e
 * aplicado de qualquer forma e o motivo vai para o log e para o `audit_logs`.
 */
async function applyEvent(
  client: PoolClient,
  row: ChargeRow,
  changes: { chargeStatus: string | null; installmentStatus: string; paymentStatus: string | null },
  payment: PaymentPayload,
  settings: AsaasEventSettings
): Promise<ApplyOutcome> {
  await client.query(`UPDATE asaas_charges SET status = COALESCE($2, status), updated_at = now() WHERE id = $1`, [
    row.chargeId,
    changes.chargeStatus
  ]);

  if (row.installmentId !== null) {
    await client.query(`UPDATE installments SET status = $2, updated_at = now() WHERE id = $1`, [
      row.installmentId,
      changes.installmentStatus
    ]);
  }

  if (changes.paymentStatus === null || row.installmentId === null) {
    return { paymentSkipped: null, retentionSkipped: null };
  }

  const amount = payment.value ?? Number(row.originalAmount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      paymentSkipped: `valor ausente ou zero no payload (${String(payment.value)})`,
      retentionSkipped: 'sem lancamento em payments'
    };
  }

  const upserted = await client.query<{ id: string }>(
    `INSERT INTO payments (installment_id, amount, paid_at, status, source, external_id)
     VALUES ($1, $2, $3, $4, 'asaas', $5)
     ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET amount = EXCLUDED.amount, status = EXCLUDED.status,
                   paid_at = COALESCE(EXCLUDED.paid_at, payments.paid_at), updated_at = now()
     RETURNING id`,
    [row.installmentId, amount, paidAtOf(payment) ?? new Date(), changes.paymentStatus, payment.id]
  );
  const paymentId = String(upserted.rows[0]?.id ?? '');
  const retentionSkipped = await applyRetention(client, row, changes, paymentId, amount, settings);
  return { paymentSkipped: null, retentionSkipped };
}

async function processEvent(
  deps: AsaasEventWorkerDeps,
  settings: AsaasEventSettings,
  message: ClaimedAsaasEvent,
  tally: AsaasEventCycleResult
): Promise<void> {
  const { pool, logger } = deps;
  const startedAt = Date.now();
  const baseLog = {
    eventId: message.id,
    externalEventId: message.externalEventId,
    eventType: message.eventType,
    externalChargeId: message.externalChargeId,
    attempt: message.attempts,
    maxAttempts: settings.maxAttempts
  };

  try {
    const payment = parsePayment(message);
    const externalChargeId = message.externalChargeId ?? payment.id;
    const charge = await findCharge(pool, externalChargeId);
    if (!charge || charge.installmentId === null || charge.installmentStatus === null) {
      await markAsaasEventProcessed(pool, message.id, { failureReason: 'charge not found' });
      tally.orphan += 1;
      logger.warn({ ...baseLog, externalChargeId, durationMs: Date.now() - startedAt }, 'asaas.event.orphan');
      return;
    }

    const chargeStatus = normalizeChargeStatus(payment.status);
    const transition = resolveTransition(message.eventType, charge.installmentStatus);

    if (transition.outcome === 'ignored' || transition.outcome === 'stale') {
      if (chargeStatus !== null) {
        await pool.query(`UPDATE asaas_charges SET status = $2, updated_at = now() WHERE id = $1`, [
          charge.chargeId,
          chargeStatus
        ]);
      }
      await markAsaasEventProcessed(pool, message.id);
      if (transition.outcome === 'ignored') {
        tally.ignored += 1;
        logger.debug({ ...baseLog, durationMs: Date.now() - startedAt, outcome: 'ignored' }, 'asaas.event.ignored');
      } else {
        tally.stale += 1;
        logger.info(
          { ...baseLog, durationMs: Date.now() - startedAt, outcome: 'stale', from: transition.from, to: transition.to },
          'asaas.event.stale'
        );
      }
      return;
    }

    const client = await pool.connect();
    let outcome: ApplyOutcome = { paymentSkipped: null, retentionSkipped: null };
    try {
      await client.query('BEGIN');
      outcome = await applyEvent(
        client,
        charge,
        { chargeStatus, installmentStatus: transition.to, paymentStatus: transition.paymentStatus },
        payment,
        settings
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    await markAsaasEventProcessed(pool, message.id);
    tally.applied += 1;
    if (outcome.paymentSkipped !== null) {
      logger.warn({ ...baseLog, reason: outcome.paymentSkipped, externalChargeId }, 'asaas.event.payment_skipped');
    }
    if (outcome.retentionSkipped !== null) {
      logger.debug({ ...baseLog, reason: outcome.retentionSkipped, externalChargeId }, 'asaas.event.retention_skipped');
    }

    const changedInstallment = transition.to !== transition.from;
    await recordAudit(pool, logger, message.externalEventId, {
      action: changedInstallment ? 'installment.status_changed' : 'payment.updated',
      entityType: changedInstallment ? 'installments' : 'payments',
      entityId: charge.installmentId,
      metadata: {
        event: message.eventType,
        externalEventId: message.externalEventId,
        externalChargeId,
        from: transition.from,
        to: transition.to,
        paymentStatus: transition.paymentStatus,
        ...(outcome.paymentSkipped === null ? {} : { paymentSkipped: outcome.paymentSkipped }),
        ...(outcome.retentionSkipped === null ? {} : { retentionSkipped: outcome.retentionSkipped })
      }
    });
    logger.info(
      {
        ...baseLog,
        durationMs: Date.now() - startedAt,
        outcome: 'applied',
        from: transition.from,
        to: transition.to,
        paymentStatus: transition.paymentStatus
      },
      'asaas.event.applied'
    );
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : `unknown error: ${String(error)}`;
    const failure = await failAsaasEvent(pool, message.id, { reason, maxAttempts: settings.maxAttempts });
    const payload = { ...baseLog, durationMs: Date.now() - startedAt, reason, attempts: failure.attempts };
    if (failure.exhausted) {
      tally.failed += 1;
      logger.error(payload, 'asaas.event.dead');
    } else {
      tally.retried += 1;
      logger.warn(payload, 'asaas.event.retry');
    }
  }
}

/** Um ciclo completo. Exportado para o teste exercitar o laco sem esperar o timer. */
export async function runAsaasEventsCycle(
  deps: AsaasEventWorkerDeps,
  settings: AsaasEventSettings
): Promise<AsaasEventCycleResult> {
  const messages = await claimAsaasEventBatch(deps.pool, {
    limit: settings.batchSize,
    maxAttempts: settings.maxAttempts,
    leaseTimeoutMs: settings.leaseTimeoutMs
  });
  const tally: AsaasEventCycleResult = {
    claimed: messages.length,
    applied: 0,
    stale: 0,
    ignored: 0,
    orphan: 0,
    retried: 0,
    failed: 0
  };
  for (const message of messages) {
    await processEvent(deps, settings, message, tally);
  }
  return tally;
}

export interface AsaasEventWorker {
  enabled: boolean;
  /** Acorda o laco agora; o webhook chama depois do `INSERT`. */
  wake(): void;
  stop(options?: { timeoutMs?: number }): Promise<void>;
}

export interface AsaasEventWorkerOptions extends AsaasEventWorkerDeps {
  settings: AsaasEventSettings;
  pollIntervalMs: number;
  enabled: boolean;
}

const noopEventWorker = (logger: FastifyBaseLogger, message: string): AsaasEventWorker => {
  logger.warn({ asaasEventWorker: message }, 'asaas events worker not started');
  return { enabled: false, wake: () => {}, stop: async () => {} };
};

/**
 * Sobe o laco de entrada. Mesmo desenho do outbox: `setTimeout` recursivo, concorrencia 1, timer
 * `unref()`. A diferenca e que aqui nao existe dependencia de chave do Asaas - o evento chega pelo
 * webhook, e o consumidor so precisa do banco.
 */
export function startAsaasEventsWorker(options: AsaasEventWorkerOptions): AsaasEventWorker {
  const { pool, logger, settings } = options;
  if (!options.enabled) return noopEventWorker(logger, 'disabled by ASAAS_EVENTS_WORKER_ENABLED');

  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let cycles = 0;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delayMs);
    timer.unref();
  };

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    timer = null;
    const cycle = (async () => {
      try {
        const result = await runAsaasEventsCycle({ pool, logger }, settings);
        cycles += 1;
        if (result.claimed > 0) logger.info({ ...result, cycle: cycles }, 'asaas events cycle finished');
      } catch (error) {
        // Um ciclo nunca rejeita: promise rejeitada sem `catch` derruba o processo no Node 22.
        logger.error({ err: error }, 'asaas events cycle failed');
      }
    })();
    inFlight = cycle;
    await cycle;
    inFlight = null;
    schedule(options.pollIntervalMs);
  };

  const worker: AsaasEventWorker = {
    enabled: true,
    wake() {
      if (stopped) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!inFlight) void tick();
    },
    async stop(stopOptions = {}) {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!inFlight) return;
      const timeoutMs = stopOptions.timeoutMs ?? 10_000;
      await Promise.race([
        inFlight,
        new Promise<void>((resolve) => {
          const guard = setTimeout(resolve, timeoutMs);
          guard.unref();
        })
      ]);
    }
  };

  logger.info(
    { batchSize: settings.batchSize, maxAttempts: settings.maxAttempts, pollIntervalMs: options.pollIntervalMs },
    'asaas events worker started'
  );
  void tick();
  return worker;
}

