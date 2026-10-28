import { describe, expect, it } from 'vitest';
import {
  ASAAS_DESCRIPTION_MAX_LENGTH,
  OUTBOX_TOPICS,
  OutboxPayloadError,
  ProviderError,
  attemptsExhausted,
  chargeDedupeKey,
  chargeDescription,
  classifyFailure,
  customerCreatePayload,
  customerDedupeKey,
  isOutboxTopic,
  retryDelaySeconds
} from './outbox.js';

/** `random` fixo para o jitter ser previsivel: 0.5 da o valor cheio, 0 e 1 dao os extremos. */
const fixed = (value: number) => () => value;

describe('chaves de deduplicacao', () => {
  it('sao derivadas da intencao, nao aleatorias', () => {
    const installmentId = '0c2b7a91-5e4d-4c8b-9a3f-2b1d6e8f0c11';
    const customerId = '5f1a3c47-2d8e-4a1b-9c6f-7d2e4b8a1c33';

    expect(chargeDedupeKey(installmentId)).toBe(`asaas.charge.create:${installmentId}`);
    expect(customerDedupeKey(customerId)).toBe(`asaas.customer.create:${customerId}`);
    expect(chargeDedupeKey(installmentId)).toBe(chargeDedupeKey(installmentId));
    expect(chargeDedupeKey(installmentId)).not.toBe(customerDedupeKey(installmentId));
  });

  it('prefixa com o mesmo texto do topic, para a linha da fila se explicar sozinha', () => {
    expect(chargeDedupeKey('x')).toBe(`${OUTBOX_TOPICS[1]}:x`);
    expect(customerDedupeKey('x')).toBe(`${OUTBOX_TOPICS[0]}:x`);
  });
});

describe('backoff', () => {
  it('progride 5s, 10s, 20s ... 640s sem jitter', () => {
    const semJitter = fixed(0.5);
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((attempt) => retryDelaySeconds(attempt, semJitter));
    expect(delays).toEqual([5, 10, 20, 40, 80, 160, 320, 640]);
  });

  it('respeita o teto de 15 min a partir da nona tentativa', () => {
    const semJitter = fixed(0.5);
    expect(retryDelaySeconds(9, semJitter)).toBe(900);
    expect(retryDelaySeconds(40, semJitter)).toBe(900);
  });

  it('mantem o jitter dentro de +-20%', () => {
    for (const attempt of [1, 3, 6, 9]) {
      const base = Math.min(5 * 2 ** (attempt - 1), 900);
      expect(retryDelaySeconds(attempt, fixed(0))).toBeCloseTo(base * 0.8, 6);
      expect(retryDelaySeconds(attempt, fixed(1))).toBeCloseTo(base * 1.2, 6);
      const measured = retryDelaySeconds(attempt);
      expect(measured).toBeGreaterThanOrEqual(base * 0.8 - 1);
      expect(measured).toBeLessThanOrEqual(base * 1.2 + 1);
    }
  });

  it('recusa tentativa fora da faixa em vez de gerar NaN', () => {
    expect(() => retryDelaySeconds(0)).toThrow(RangeError);
    expect(() => retryDelaySeconds(-1)).toThrow(RangeError);
    expect(() => retryDelaySeconds(1.5)).toThrow(RangeError);
    expect(() => retryDelaySeconds(Number.NaN)).toThrow(RangeError);
  });

  it('decide dead quando a tentativa atingiu o teto da linha', () => {
    expect(attemptsExhausted(1, 8)).toBe(false);
    expect(attemptsExhausted(7, 8)).toBe(false);
    expect(attemptsExhausted(8, 8)).toBe(true);
    expect(attemptsExhausted(9, 8)).toBe(true);
  });
});

describe('classificacao de falha', () => {
  const provider = (status?: number, retryAfterSeconds?: number) =>
    new ProviderError('recusado', {
      ...(status === undefined ? {} : { status }),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
    });

  it.each([400, 401, 403, 404, 409, 422, 451])('marca %i como dead, sem retry', (status) => {
    const verdict = classifyFailure(provider(status));
    expect(verdict.action).toBe('dead');
    expect(verdict.ambiguous).toBe(false);
    expect(verdict.reason).toContain(String(status));
  });

  it('trata 429 como retry e respeita o Retry-After quando vem', () => {
    expect(classifyFailure(provider(429))).toMatchObject({ action: 'retry', ambiguous: false });
    expect(classifyFailure(provider(429, 7))).toMatchObject({
      action: 'retry',
      retryAfterSeconds: 7,
      ambiguous: false
    });
  });

  it.each([408, 425, 500, 502, 503])('marca %i como retry nao ambiguo', (status) => {
    expect(classifyFailure(provider(status))).toMatchObject({ action: 'retry', ambiguous: false });
  });

  it('marca 504 como retry ambiguo (o gateway desistiu de esperar)', () => {
    expect(classifyFailure(provider(504))).toMatchObject({ action: 'retry', ambiguous: true });
  });

  it('sem status e ambiguo: a chamada saiu e a resposta se perdeu', () => {
    const timeout = new ProviderError('timeout after 30000ms');
    expect(classifyFailure(timeout)).toMatchObject({ action: 'retry', ambiguous: true });
  });

  it('payload invalido e erro de programacao morrem na primeira tentativa', () => {
    expect(classifyFailure(new OutboxPayloadError('installmentId invalido'))).toMatchObject({
      action: 'dead',
      reason: 'installmentId invalido'
    });
    expect(classifyFailure(new TypeError('x is not a function'))).toMatchObject({
      action: 'dead',
      reason: 'TypeError: x is not a function'
    });
    expect(classifyFailure('nao e erro')).toMatchObject({ action: 'dead', reason: 'unknown error: nao e erro' });
  });

  it('status fora da faixa HTTP nao vira retry silencioso', () => {
    expect(classifyFailure(provider(0))).toMatchObject({ action: 'dead' });
    expect(classifyFailure(provider(302))).toMatchObject({ action: 'dead' });
  });

  it('erro de infraestrutura (banco, socket, DNS) e retry nao ambiguo', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5434'), { code: 'ECONNREFUSED' });
    expect(classifyFailure(refused)).toMatchObject({ action: 'retry', ambiguous: false });
    const connectionFailure = Object.assign(new Error('terminating connection'), { code: '08006' });
    expect(classifyFailure(connectionFailure)).toMatchObject({ action: 'retry', ambiguous: false });
    // Erro de dado do Postgres (classe 23) continua dead: o mesmo INSERT falharia sempre.
    const constraint = Object.assign(new Error('duplicate key'), { code: '23505' });
    expect(classifyFailure(constraint)).toMatchObject({ action: 'dead' });
  });
});

describe('topics', () => {
  it('aceita apenas a lista fechada do CHECK da migration', () => {
    expect(OUTBOX_TOPICS.every(isOutboxTopic)).toBe(true);
    expect(isOutboxTopic('asaas.charge.cancel')).toBe(false);
    expect(isOutboxTopic(undefined)).toBe(false);
  });
});

describe('payload do produtor', () => {
  const customer = {
    customerId: '5f1a3c47-2d8e-4a1b-9c6f-7d2e4b8a1c33',
    fullName: '  Maria da Silva  ',
    documentNumber: null,
    email: null,
    phone: null
  };

  it('omite campo vazio em vez de mandar string vazia ao provedor', () => {
    expect(
      customerCreatePayload({ ...customer, documentNumber: '', email: '   ', phone: '' })
    ).toEqual({ customerId: customer.customerId, name: 'Maria da Silva' });
  });

  it('mantem documento com pontuacao e descarta documento curto demais', () => {
    expect(customerCreatePayload({ ...customer, documentNumber: '123.456.789-00' }).documentNumber).toBe(
      '123.456.789-00'
    );
    expect(customerCreatePayload({ ...customer, documentNumber: '123' })).not.toHaveProperty('documentNumber');
  });

  it('normaliza espacos do nome e dos contatos', () => {
    expect(
      customerCreatePayload({ ...customer, email: ' maria@example.com ', phone: ' 11999998888 ' })
    ).toMatchObject({ name: 'Maria da Silva', email: 'maria@example.com', phone: '11999998888' });
  });

  it('descreve a parcela com o acordo e trunca no limite do Asaas', () => {
    expect(chargeDescription({ installmentNumber: 2, installmentsCount: 12, reference: null })).toBe('Parcela 2/12');
    expect(
      chargeDescription({ installmentNumber: 2, installmentsCount: 12, reference: '  Matricula 2026  ' })
    ).toBe('Parcela 2/12 - Matricula 2026');
    expect(
      chargeDescription({ installmentNumber: 1, installmentsCount: 1, reference: 'x'.repeat(600) })
    ).toHaveLength(ASAAS_DESCRIPTION_MAX_LENGTH);
  });
});
