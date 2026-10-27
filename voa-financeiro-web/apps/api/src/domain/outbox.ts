/**
 * Regras puras da fila de saida (outbox) descrita em `docs/OUTBOX_DESIGN.md`.
 *
 * Nada aqui toca banco nem rede: sao as decisoes que o teste unitario consegue fixar sem Postgres -
 * qual e a chave de deduplicacao de cada intencao, quanto esperar antes de tentar de novo, e o que
 * fazer com cada resposta do provedor. O laco (`outbox/worker.ts`) e o SQL (`db/outbox.ts`) so
 * aplicam o que este modulo decide.
 *
 * A classificacao de falha e a parte que importa: retry cego em `400` transforma erro de dado em
 * ruido e enche a fila, e nao tentar em `429` perde dinheiro que o provedor aceitaria segundos
 * depois. Por isso a tabela da secao 7 do desenho mora aqui, em codigo, e nao dentro do `catch` do
 * worker.
 */

/** Topics que a fila aceita hoje. O `CHECK` da migration `0012` repete esta lista de proposito. */
export const OUTBOX_TOPICS = ['asaas.customer.create', 'asaas.charge.create'] as const;

export type OutboxTopic = (typeof OUTBOX_TOPICS)[number];

export const OUTBOX_STATUSES = ['pending', 'processing', 'done', 'dead'] as const;

export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export type OutboxEnvironment = 'sandbox' | 'production';

/** Uma linha de `outbox_events`, do ponto de vista de quem enfileira. */
export interface OutboxMessage {
  topic: OutboxTopic;
  /** Chave por **intencao**, nunca aleatoria: e ela que faz o `ON CONFLICT DO NOTHING` deduplicar. */
  dedupeKey: string;
  /** Snapshot congelado no enfileiramento; o worker nao rele a parcela para montar o pedido. */
  payload: Record<string, unknown>;
  /** Agregado dono da intencao, para o retry manual reconstruir o contexto. */
  entity: { type: string; id: string };
  /** `request.id` do Fastify: liga requisicao HTTP, linha da fila e `audit_logs`. */
  correlationId: string;
}

export function customerDedupeKey(customerId: string): string {
  return `asaas.customer.create:${customerId}`;
}

export function chargeDedupeKey(installmentId: string): string {
  return `asaas.charge.create:${installmentId}`;
}

/** Base do backoff: a primeira tentativa falha e a segunda acontece ~5s depois. */
export const OUTBOX_BASE_DELAY_SECONDS = 5;

/** Teto do backoff: 15 min. 8 tentativas cobrem ~21 min de provedor fora do ar. */
export const OUTBOX_MAX_DELAY_SECONDS = 900;

/** Jitter de +-20%, para um lote inteiro que falhou junto nao voltar em sincronia. */
export const OUTBOX_JITTER_RATIO = 0.2;

/**
 * Quanto esperar depois da tentativa numero `attempts` (1 = a primeira).
 *
 * `5s, 10s, 20s, 40s, 80s, 160s, 320s, 640s` e depois o teto de 900s. O `random` e injetavel para o
 * teste fixar o jitter; em producao e `Math.random`.
 */
export function retryDelaySeconds(attempts: number, random: () => number = Math.random): number {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`attempts must be a positive integer, got ${String(attempts)}`);
  }
  const exponential = OUTBOX_BASE_DELAY_SECONDS * 2 ** (attempts - 1);
  const capped = Math.min(exponential, OUTBOX_MAX_DELAY_SECONDS);
  const factor = 1 - OUTBOX_JITTER_RATIO + random() * (OUTBOX_JITTER_RATIO * 2);
  return Math.round(capped * factor * 1000) / 1000;
}

/** Atingiu o teto da propria linha: a proxima falha e `dead`, nao `pending`. */
export function attemptsExhausted(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts;
}

export function isOutboxTopic(value: unknown): value is OutboxTopic {
  return typeof value === 'string' && (OUTBOX_TOPICS as readonly string[]).includes(value);
}

/**
 * Erro do provedor, ja normalizado pelo cliente HTTP (`integrations/asaas-client.ts`).
 *
 * `status` ausente significa **resultado ambiguo**: a chamada saiu e a resposta se perdeu (timeout,
 * `ECONNRESET`, DNS). Esse e o unico caso em que o handler precisa conciliar antes de reenviar - ver
 * secao 8 do desenho.
 */
export class ProviderError extends Error {
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, options: { status?: number; retryAfterSeconds?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/**
 * Payload que nao descreve uma intencao valida (campo faltando, uuid errado, valor negativo).
 *
 * Vira `dead` na primeira tentativa: o mesmo `payload` produziria o mesmo erro sempre, e um retry so
 * adia a leitura humana da linha.
 */
export class OutboxPayloadError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OutboxPayloadError';
  }
}

export type FailureAction = 'retry' | 'dead';

export interface FailureVerdict {
  action: FailureAction;
  /** Texto que vai para `last_error`; curto e sem dado sensivel (payload nao entra aqui). */
  reason: string;
  /** Quando o provedor disse quanto esperar (`Retry-After`), o backoff respeita. */
  retryAfterSeconds?: number;
  /** A chamada pode ter sido aplicada no provedor mesmo tendo falhado aqui. */
  ambiguous: boolean;
}

/**
 * Tabela da secao 7 do desenho, em codigo.
 *
 * | resposta | acao |
 * |---|---|
 * | `429` | retry, respeitando `Retry-After` |
 * | `408`, `425` | retry (o pedido nem foi lido) |
 * | `5xx` | retry; `504` e ambiguo, o resto nao |
 * | `400`, `401`, `403`, `404`, `409`, `422`, demais `4xx` | dead |
 * | sem `status` (timeout, `ECONNRESET`) | retry e ambiguo -> conciliar antes |
 * | payload invalido, erro de programacao | dead |
 *
 * Um 401/403 merece `log.error` no worker alem do `dead`: e chave errada ou integracao revogada, e o
 * sintoma so aparece quando a fila ja parou.
 */
export function classifyFailure(error: unknown): FailureVerdict {
  if (error instanceof OutboxPayloadError) {
    return { action: 'dead', reason: error.message, ambiguous: false };
  }
  if (error instanceof ProviderError) {
    const status = error.status;
    if (status === undefined) {
      return { action: 'retry', reason: error.message, ambiguous: true };
    }
    if (status === 429) {
      return error.retryAfterSeconds === undefined
        ? { action: 'retry', reason: `429 rate limited: ${error.message}`, ambiguous: false }
        : {
            action: 'retry',
            reason: `429 rate limited: ${error.message}`,
            retryAfterSeconds: error.retryAfterSeconds,
            ambiguous: false
          };
    }
    if (status === 408 || status === 425) {
      return { action: 'retry', reason: `${status}: ${error.message}`, ambiguous: false };
    }
    if (status >= 500) {
      // `504` e o gateway desistindo de esperar: o provedor pode ter processado. `500`, `502` e
      // `503` chegam com corpo, entao o provedor recusou e o reenvio e seguro.
      return { action: 'retry', reason: `${status}: ${error.message}`, ambiguous: status === 504 };
    }
    if (status >= 400) {
      return { action: 'dead', reason: `${status}: ${error.message}`, ambiguous: false };
    }
    return { action: 'dead', reason: `unexpected status ${status}: ${error.message}`, ambiguous: false };
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : `unknown error: ${String(error)}`;
  return { action: 'dead', reason: message, ambiguous: false };
}
