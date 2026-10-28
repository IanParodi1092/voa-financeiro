import type { FastifyBaseLogger } from 'fastify';
import { hostname } from 'node:os';
import type { Pool } from 'pg';
import { recordAudit } from '../audit.js';
import {
  claimOutboxBatch,
  markOutboxDead,
  markOutboxDone,
  purgeDoneOutbox,
  releaseExpiredLeases,
  scheduleOutboxRetry,
  type ClaimedMessage
} from '../db/outbox.js';
import { attemptsExhausted, classifyFailure, retryDelaySeconds, type OutboxEnvironment } from '../domain/outbox.js';
import type { AsaasClient } from '../integrations/asaas-client.js';
import { topicHandlers } from './handlers.js';

/**
 * O laco que consome `outbox_events` dentro do processo da API.
 *
 * Estrutura de cada ciclo: reaper de lease -> claim de ate `batchSize` -> processa em serie -> dorme.
 * Duas escolhas com consequencia:
 *
 * - **`setTimeout` recursivo, nao `setInterval`.** Com `setInterval`, um ciclo lento (Asaas com
 *   latencia alta) empilha ciclos concorrentes e o paralelismo efetivo deixa de ser 1.
 * - **Concorrencia 1.** O gargalo real e o provedor, e um lote pequeno mantem o custo de conexao
 *   previsivel - o worker usa no maximo 1 conexao do pool por vez.
 */

export interface OutboxSettings {
  environment: OutboxEnvironment;
  pollIntervalMs: number;
  batchSize: number;
  leaseTimeoutMs: number;
  /** Dias de historico de `done`. `0` desliga o expurgo; `dead` nunca e expurgada. */
  retentionDays: number;
}

export interface OutboxWorkerDeps {
  pool: Pool;
  logger: FastifyBaseLogger;
  asaas: AsaasClient;
  /** `hostname:pid`; vai para `locked_by`, para o operador saber qual processo pegou a linha. */
  workerId?: string;
}

export interface OutboxCycleResult {
  /** Linhas devolvidas para `pending` pelo reaper. */
  released: number;
  /** Linhas que o reaper matou por ja terem gastado as tentativas. */
  expired: number;
  /** Linhas `done` removidas pela retencao; `0` na maioria dos ciclos. */
  purged: number;
  claimed: number;
  done: number;
  retried: number;
  dead: number;
}

/** O que o chamador pede do ciclo alem da configuracao fixa. */
export interface OutboxCycleOptions {
  /** Pede o expurgo de `done` antigos; o laco passa `true` uma vez por hora, nao a cada poll. */
  purgeDone?: boolean;
}

const defaultWorkerId = (): string => `${hostname()}:${process.pid}`;

async function processMessage(
  deps: OutboxWorkerDeps,
  settings: OutboxSettings,
  message: ClaimedMessage,
  tally: OutboxCycleResult
): Promise<void> {
  const { pool, logger, asaas } = deps;
  const correlationId = message.correlationId ?? message.id;
  const startedAt = Date.now();
  const baseLog = {
    outboxId: message.id,
    topic: message.topic,
    attempt: message.attempts,
    maxAttempts: message.maxAttempts,
    correlationId,
    entityType: message.entityType,
    entityId: message.entityId
  };

  try {
    const outcome = await topicHandlers[message.topic]({
      pool,
      asaas,
      environment: settings.environment,
      logger,
      message
    });
    await markOutboxDone(pool, message.id, outcome.note);
    tally.done += 1;
    await recordAudit(pool, logger, correlationId, {
      action: 'outbox.done',
      entityType: message.entityType,
      entityId: message.entityId,
      metadata: {
        topic: message.topic,
        attempts: message.attempts,
        dedupeKey: message.dedupeKey,
        ...(outcome.note === undefined ? {} : { note: outcome.note })
      }
    });
    logger.info({ ...baseLog, durationMs: Date.now() - startedAt, outcome: 'done' }, 'outbox message done');
  } catch (error) {
    const verdict = classifyFailure(error);
    const exhausted = attemptsExhausted(message.attempts, message.maxAttempts);
    if (verdict.action === 'dead' || exhausted) {
      const reason = exhausted && verdict.action === 'retry' ? `${verdict.reason} (max attempts reached)` : verdict.reason;
      await markOutboxDead(pool, message.id, reason);
      tally.dead += 1;
      await recordAudit(pool, logger, correlationId, {
        action: 'outbox.dead',
        entityType: message.entityType,
        entityId: message.entityId,
        metadata: { topic: message.topic, attempts: message.attempts, reason }
      });
      // 401/403 e chave errada ou integracao revogada: a fila inteira vai parar, entao o log sobe
      // para `error` em vez de se perder entre `warn` de payload invalido.
      const logError = /^(401|403):/.test(reason);
      const payload = { ...baseLog, durationMs: Date.now() - startedAt, outcome: 'dead', reason };
      if (logError) logger.error(payload, 'outbox message dead (provider auth)');
      else logger.warn(payload, 'outbox message dead');
      return;
    }

    // `Retry-After` do provedor vence o backoff calculado: ele sabe quando vai aceitar de novo.
    const delaySeconds = verdict.retryAfterSeconds ?? retryDelaySeconds(message.attempts);
    await scheduleOutboxRetry(pool, message.id, { delaySeconds, reason: verdict.reason });
    tally.retried += 1;
    logger.warn(
      { ...baseLog, durationMs: Date.now() - startedAt, outcome: 'retry', retryInSeconds: delaySeconds, reason: verdict.reason },
      'outbox message scheduled for retry'
    );
  }
}

/** Um ciclo completo. Exportado para o teste exercitar o laco sem esperar o timer. */
export async function runOutboxCycle(
  deps: OutboxWorkerDeps,
  settings: OutboxSettings,
  options: OutboxCycleOptions = {}
): Promise<OutboxCycleResult> {
  const { pool, logger } = deps;
  const reaped = await releaseExpiredLeases(pool, {
    environment: settings.environment,
    timeoutMs: settings.leaseTimeoutMs
  });
  if (reaped.released > 0 || reaped.dead > 0) {
    logger.warn({ released: reaped.released, expired: reaped.dead }, 'outbox leases recovered');
  }

  let purged = 0;
  if (options.purgeDone && settings.retentionDays > 0) {
    try {
      purged = (await purgeDoneOutbox(pool, { retentionDays: settings.retentionDays })).purged;
      if (purged > 0) logger.info({ purged, retentionDays: settings.retentionDays }, 'outbox done rows purged');
    } catch (error) {
      // Retencao e higiene: se o DELETE falhar, as mensagens deste ciclo ainda precisam sair.
      logger.error({ err: error }, 'outbox purge failed');
    }
  }

  const messages = await claimOutboxBatch(pool, {
    environment: settings.environment,
    limit: settings.batchSize,
    workerId: deps.workerId ?? defaultWorkerId()
  });
  const tally: OutboxCycleResult = {
    released: reaped.released,
    expired: reaped.dead,
    purged,
    claimed: messages.length,
    done: 0,
    retried: 0,
    dead: 0
  };
  for (const message of messages) {
    await processMessage(deps, settings, message, tally);
  }
  return tally;
}

export interface OutboxWorker {
  /** Falso quando o laco nao roda (desligado por config ou sem chave do Asaas). */
  enabled: boolean;
  /** Acorda o laco agora; quem enfileirou chama depois do COMMIT. */
  wake(): void;
  /** Para o laco e espera o ciclo em andamento, no maximo `timeoutMs`. */
  stop(options?: { timeoutMs?: number }): Promise<void>;
}

export interface OutboxWorkerOptions extends Omit<OutboxWorkerDeps, 'asaas'> {
  settings: OutboxSettings;
  /** `OUTBOX_WORKER_ENABLED`: desliga o laco sem desligar o enfileiramento. */
  enabled: boolean;
  /** Sem cliente a fila enche e nao sai: util para subir a API local sem chave do Asaas. */
  asaas?: AsaasClient | undefined;
}

const noopWorker = (logger: FastifyBaseLogger, message: string): OutboxWorker => {
  logger.warn({ outboxWorker: message }, 'outbox worker not started');
  return { enabled: false, wake: () => {}, stop: async () => {} };
};

/**
 * Intervalo do expurgo de `done`. Uma hora: expurgar a cada poll (2s) faria um `DELETE` vazio por
 * segundo, e uma vez por boot deixaria a tabela grande se a API ficar semanas no ar.
 */
const PURGE_INTERVAL_MS = 3_600_000;

/**
 * Sobe o laco. Devolve sempre um `OutboxWorker`: quando nao ha o que fazer, um no-op que diz por que.
 *
 * O timer e `unref()`, para o laco nao segurar o processo sozinho: quem mantem a API viva e o
 * `listen`, e no teste a suite nao pode ficar pendurada esperando o proximo poll.
 */
export function startOutboxWorker(options: OutboxWorkerOptions): OutboxWorker {
  const { pool, logger, settings } = options;
  if (!options.enabled) return noopWorker(logger, 'disabled by OUTBOX_WORKER_ENABLED');
  const asaas = options.asaas;
  if (!asaas) return noopWorker(logger, 'asaas client not configured (ASAAS_API_KEY)');

  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let cycles = 0;
  /** Primeiro expurgo ja no primeiro ciclo: o operador ve o efeito sem esperar uma hora. */
  let nextPurgeAt = 0;

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
        const purgeDone = Date.now() >= nextPurgeAt;
        if (purgeDone) nextPurgeAt = Date.now() + PURGE_INTERVAL_MS;
        const result = await runOutboxCycle(
          { pool, logger, asaas, ...(options.workerId === undefined ? {} : { workerId: options.workerId }) },
          settings,
          { purgeDone }
        );
        cycles += 1;
        if (result.claimed > 0 || result.purged > 0) logger.info({ ...result, cycle: cycles }, 'outbox cycle finished');
      } catch (error) {
        // O ciclo nunca rejeita: uma promise rejeitada sem `catch` derruba o processo no Node 22.
        logger.error({ err: error }, 'outbox cycle failed');
      }
    })();
    inFlight = cycle;
    await cycle;
    inFlight = null;
    schedule(settings.pollIntervalMs);
  };

  const worker: OutboxWorker = {
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
    { environment: settings.environment, pollIntervalMs: settings.pollIntervalMs, batchSize: settings.batchSize },
    'outbox worker started'
  );
  void tick();
  return worker;
}
