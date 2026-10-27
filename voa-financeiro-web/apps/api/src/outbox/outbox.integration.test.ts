import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { loadConfig } from '../config.js';
import { claimOutboxBatch, enqueueOutbox, markOutboxDead, releaseExpiredLeases } from '../db/outbox.js';
import { applyMigrations } from '../db/run-migrations.js';
import { ProviderError, chargeDedupeKey } from '../domain/outbox.js';
import type { AsaasCharge, AsaasClient } from '../integrations/asaas-client.js';
import { runOutboxCycle, type OutboxSettings } from './worker.js';

/**
 * Integracao do outbox contra um PostgreSQL descartavel.
 *
 * Mesmo harness de `app.integration.test.ts`: schema temporario, `applyMigrations`, nada e alterado no
 * banco escolhido. O `AsaasClient` e um fake local - **nenhum teste toca a rede** - e o relogio do
 * backoff anda com `UPDATE available_at = now() - interval '1 second'`, para o teste exercitar a
 * maquina de estados em vez de esperar 5s de verdade.
 *
 *   docker exec voa-staging createdb -U postgres voa_api_test
 *   $env:TEST_DATABASE_URL = "postgresql://postgres:SENHA@localhost:5434/voa_api_test"
 *   npm run test:integration
 */
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describeWithDatabase = connectionString ? describe : describe.skip;
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const schemaName = `outbox_it_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const PASSWORD = 'senha-de-teste-123456';

const SETTINGS: OutboxSettings = {
  environment: 'sandbox',
  pollIntervalMs: 10,
  batchSize: 5,
  leaseTimeoutMs: 300_000
};

/** Fake do provedor: conta chamadas por chave e deixa o teste enfileirar falhas por chave. */
class FakeAsaasClient implements AsaasClient {
  readonly calls: string[] = [];
  private readonly failures = new Map<string, unknown[]>();
  private readonly byReference = new Map<string, AsaasCharge>();
  private sequence = 0;

  async createCustomer(input: { externalReference: string }): Promise<{ externalId: string }> {
    this.calls.push(`customer:${input.externalReference}`);
    return { externalId: `cus_${++this.sequence}` };
  }

  async createCharge(input: { externalReference: string }): Promise<AsaasCharge> {
    this.calls.push(`charge:${input.externalReference}`);
    const failure = this.failures.get(input.externalReference)?.shift();
    if (failure !== undefined) throw failure;
    return this.remember(input.externalReference);
  }

  async findChargeByExternalReference(externalReference: string): Promise<AsaasCharge | null> {
    this.calls.push(`find:${externalReference}`);
    return this.byReference.get(externalReference) ?? null;
  }

  /** Proxima chamada desta `externalReference` falha; as seguintes seguem o roteiro normal. */
  failNext(reference: string, error: unknown): void {
    const queue = this.failures.get(reference) ?? [];
    queue.push(error);
    this.failures.set(reference, queue);
  }

  /** Cobranca que ja existe no provedor (cenario de conciliacao). */
  seed(reference: string): AsaasCharge {
    return this.remember(reference);
  }

  callsOf(kind: 'customer' | 'charge' | 'find'): string[] {
    return this.calls.filter((call) => call.startsWith(`${kind}:`));
  }

  private remember(reference: string): AsaasCharge {
    const charge: AsaasCharge = {
      externalId: `pay_${++this.sequence}`,
      status: 'PENDING',
      invoiceUrl: 'https://sandbox.asaas.com/i/inv',
      bankSlipUrl: null
    };
    this.byReference.set(reference, charge);
    return charge;
  }
}

describeWithDatabase('integracao: outbox + worker em processo', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;
  const fake = new FakeAsaasClient();

  const tokenOf = async (email: string): Promise<string> => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
    expect(response.statusCode).toBe(200);
    return (response.json() as { accessToken: string }).accessToken;
  };

  const cycle = () => runOutboxCycle({ pool, logger: app.log, asaas: fake, workerId: 'test:1' }, SETTINGS);

  const countRows = async (): Promise<number> => {
    const result = await pool.query<{ total: number }>('SELECT count(*)::int AS total FROM outbox_events');
    return result.rows[0]?.total ?? 0;
  };

  const statusOf = async (id: string) => {
    const result = await pool.query<{
      status: string;
      attempts: number;
      lastError: string | null;
      completedAt: string | null;
    }>(
      `SELECT status, attempts, last_error AS "lastError", completed_at AS "completedAt"
         FROM outbox_events WHERE id = $1`,
      [id]
    );
    return result.rows[0];
  };

  /** Cadeia minima: escola -> cliente -> acordo -> parcela -> cliente no Asaas. */
  const createFixtures = async () => {
    const suffix = randomUUID().slice(0, 8);
    const school = await pool.query<{ id: string }>('INSERT INTO schools (legal_name) VALUES ($1) RETURNING id', [
      `Escola ${suffix}`
    ]);
    const customer = await pool.query<{ id: string }>('INSERT INTO customers (full_name) VALUES ($1) RETURNING id', [
      `Cliente ${suffix}`
    ]);
    const agreement = await pool.query<{ id: string }>(
      `INSERT INTO agreements (school_id, customer_id, total_amount, installments_count)
       VALUES ($1, $2, 150.50, 1) RETURNING id`,
      [school.rows[0]?.id, customer.rows[0]?.id]
    );
    const installment = await pool.query<{ id: string }>(
      `INSERT INTO installments (agreement_id, installment_number, due_date, original_amount)
       VALUES ($1, 1, '2026-11-10', 150.50) RETURNING id`,
      [agreement.rows[0]?.id]
    );
    const asaasCustomer = await pool.query<{ id: string }>(
      `INSERT INTO asaas_customers (customer_id, external_id, environment)
       VALUES ($1, $2, 'sandbox') RETURNING id`,
      [customer.rows[0]?.id, `cus_seed_${suffix}`]
    );
    return {
      customerId: String(customer.rows[0]?.id),
      installmentId: String(installment.rows[0]?.id),
      asaasCustomerId: String(asaasCustomer.rows[0]?.id)
    };
  };

  const enqueueFor = async (
    fixtures: { installmentId: string; asaasCustomerId: string },
    options: { maxAttempts?: number } = {}
  ): Promise<string> => {
    const dedupeKey = chargeDedupeKey(fixtures.installmentId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const created = await enqueueOutbox(
        client,
        {
          topic: 'asaas.charge.create',
          dedupeKey,
          payload: {
            installmentId: fixtures.installmentId,
            asaasCustomerId: fixtures.asaasCustomerId,
            billingType: 'BOLETO',
            value: 150.5,
            dueDate: '2026-11-10'
          },
          entity: { type: 'installments', id: fixtures.installmentId },
          correlationId: 'test-correlation'
        },
        { environment: 'sandbox', maxAttempts: options.maxAttempts ?? 3 }
      );
      expect(created).toBe(true);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const row = await pool.query<{ id: string }>('SELECT id FROM outbox_events WHERE dedupe_key = $1', [dedupeKey]);
    return String(row.rows[0]?.id);
  };

  /** Move o relogio do backoff sem dormir: a linha vira "pronta" para o proximo ciclo. */
  const releaseClock = async (id: string): Promise<void> => {
    await pool.query(`UPDATE outbox_events SET available_at = now() - interval '1 second' WHERE id = $1`, [id]);
  };

  /** Zera a fila entre cenarios, para o claim de um teste nao pegar linha de outro. */
  const drainQueue = async (): Promise<void> => {
    await pool.query(`UPDATE outbox_events SET status = 'done', completed_at = now() WHERE status <> 'done'`);
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString, max: 4, options: `-c search_path=${schemaName}` });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await applyMigrations(pool, migrationsDirectory);
    for (const [email, role] of [
      ['admin@example.com', 'admin'],
      ['viewer@example.com', 'viewer']
    ] as const) {
      await pool.query('INSERT INTO roles (name, description) VALUES ($1, $1) ON CONFLICT (name) DO NOTHING', [role]);
      const inserted = await pool.query<{ id: string }>(
        'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id',
        [email, await hashPassword(PASSWORD), role]
      );
      await pool.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = $2', [
        inserted.rows[0]?.id,
        role
      ]);
    }
    app = buildApp(
      loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        DATABASE_URL: connectionString,
        AUTH_JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters',
        AUTH_REFRESH_SECRET: 'test-refresh-secret-that-is-also-32-characters',
        COOKIE_SECURE: 'false'
      }),
      pool
    );
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.end();
    }
  });

  it('nao deixa linha quando a transacao do produtor sofre ROLLBACK', async () => {
    const fixtures = await createFixtures();
    const dedupeKey = chargeDedupeKey(fixtures.installmentId);
    const before = await countRows();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await enqueueOutbox(
        client,
        {
          topic: 'asaas.charge.create',
          dedupeKey,
          payload: { installmentId: fixtures.installmentId, asaasCustomerId: fixtures.asaasCustomerId },
          entity: { type: 'installments', id: fixtures.installmentId },
          correlationId: 'rollback-case'
        },
        { environment: 'sandbox', maxAttempts: 8 }
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await countRows()).toBe(before);
    const rows = await pool.query('SELECT 1 FROM outbox_events WHERE dedupe_key = $1', [dedupeKey]);
    expect(rows.rowCount).toBe(0);
  });

  it('deduplica por intencao: o segundo POST devolve false e nao cria linha', async () => {
    const fixtures = await createFixtures();
    const id = await enqueueFor(fixtures);
    const dedupeKey = chargeDedupeKey(fixtures.installmentId);
    const client = await pool.connect();
    let second = true;
    try {
      await client.query('BEGIN');
      second = await enqueueOutbox(
        client,
        {
          topic: 'asaas.charge.create',
          dedupeKey,
          payload: { installmentId: fixtures.installmentId, asaasCustomerId: fixtures.asaasCustomerId },
          entity: { type: 'installments', id: fixtures.installmentId },
          correlationId: 'duplicate-case'
        },
        { environment: 'sandbox', maxAttempts: 8 }
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(second).toBe(false);
    const rows = await pool.query<{ id: string }>('SELECT id FROM outbox_events WHERE dedupe_key = $1', [dedupeKey]);
    expect(rows.rowCount).toBe(1);
    expect(String(rows.rows[0]?.id)).toBe(id);
  });

  it('500 agenda retry e a segunda tentativa conclui a cobranca', async () => {
    const fixtures = await createFixtures();
    const id = await enqueueFor(fixtures);
    fake.failNext(chargeDedupeKey(fixtures.installmentId), new ProviderError('upstream unavailable', { status: 503 }));

    const first = await cycle();
    expect(first.retried).toBeGreaterThanOrEqual(1);
    const afterFailure = await statusOf(id);
    expect(afterFailure).toMatchObject({ status: 'pending', attempts: 1, completedAt: null });
    expect(afterFailure?.lastError).toContain('503');

    await releaseClock(id);
    const second = await cycle();
    expect(second.done).toBeGreaterThanOrEqual(1);

    const done = await statusOf(id);
    expect(done?.status).toBe('done');
    expect(done?.attempts).toBe(2);
    expect(done?.completedAt).not.toBeNull();

    const charge = await pool.query<{ status: string }>(
      'SELECT status FROM asaas_charges WHERE installment_id = $1',
      [fixtures.installmentId]
    );
    expect(charge.rowCount).toBe(1);
    expect(charge.rows[0]?.status).toBe('PENDING');
    // A tentativa 2 concilia antes de reenviar (secao 8 do desenho).
    expect(fake.callsOf('find').length).toBeGreaterThan(0);
  });

  it('400 morre na primeira tentativa, sem backoff', async () => {
    const fixtures = await createFixtures();
    const id = await enqueueFor(fixtures);
    fake.failNext(
      chargeDedupeKey(fixtures.installmentId),
      new ProviderError('value must be greater than 0', { status: 400 })
    );

    const result = await cycle();
    expect(result.dead).toBeGreaterThanOrEqual(1);

    const row = await statusOf(id);
    expect(row).toMatchObject({ status: 'dead', attempts: 1 });
    expect(row?.lastError).toContain('400');
    expect(row?.completedAt).not.toBeNull();
    expect(fake.callsOf('charge').filter((call) => call.endsWith(fixtures.installmentId))).toHaveLength(1);
  });

  it('falha ambigua concilia com o provedor em vez de reenviar', async () => {
    const fixtures = await createFixtures();
    const id = await enqueueFor(fixtures);
    const dedupeKey = chargeDedupeKey(fixtures.installmentId);
    // A cobranca ja existe no provedor: o POST anterior saiu e a resposta se perdeu.
    const seeded = fake.seed(dedupeKey);
    fake.failNext(dedupeKey, new ProviderError('POST /payments sem resposta (TimeoutError)', {}));

    const result = await cycle();
    expect(result.done).toBeGreaterThanOrEqual(1);

    const row = await statusOf(id);
    expect(row?.status).toBe('done');
    expect(row?.lastError).toBe('recovered by reconciliation');

    const charge = await pool.query<{ externalId: string }>(
      'SELECT external_id AS "externalId" FROM asaas_charges WHERE installment_id = $1',
      [fixtures.installmentId]
    );
    expect(charge.rowCount).toBe(1);
    expect(charge.rows[0]?.externalId).toBe(seeded.externalId);
    expect(fake.callsOf('charge').filter((call) => call === `charge:${dedupeKey}`)).toHaveLength(1);
  });

  it('lease vencido volta para pending e o ciclo seguinte processa', async () => {
    await drainQueue();
    const fixtures = await createFixtures();
    const id = await enqueueFor(fixtures);

    const claimed = await claimOutboxBatch(pool, { environment: 'sandbox', limit: 5, workerId: 'test:crashed' });
    expect(claimed.map((message) => message.id)).toContain(id);
    expect((await statusOf(id))?.status).toBe('processing');

    // Processo morto no meio do envio: o lease passa a estar vencido.
    await pool.query(`UPDATE outbox_events SET locked_at = now() - interval '10 minutes' WHERE id = $1`, [id]);
    const reaped = await releaseExpiredLeases(pool, {
      environment: 'sandbox',
      timeoutMs: SETTINGS.leaseTimeoutMs
    });
    expect(reaped.released).toBeGreaterThanOrEqual(1);
    expect(await statusOf(id)).toMatchObject({ status: 'pending', attempts: 1, lastError: 'lease expired' });

    const result = await cycle();
    expect(result.done).toBeGreaterThanOrEqual(1);
    const done = await statusOf(id);
    expect(done?.status).toBe('done');
    expect(done?.attempts).toBe(2);
  });

  it('dois ciclos concorrentes processam cada mensagem uma vez (SKIP LOCKED)', async () => {
    await drainQueue();
    const fixtures = await Promise.all(Array.from({ length: 5 }, () => createFixtures()));
    const ids = await Promise.all(fixtures.map((item) => enqueueFor(item)));

    const [first, second] = await Promise.all([cycle(), cycle()]);
    expect(first.claimed + second.claimed).toBe(5);

    for (const item of fixtures) {
      const key = chargeDedupeKey(item.installmentId);
      expect(fake.callsOf('charge').filter((call) => call === `charge:${key}`)).toHaveLength(1);
    }
    const done = await pool.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM outbox_events WHERE id = ANY($1::uuid[]) AND status = 'done'`,
      [ids]
    );
    expect(done.rows[0]?.total).toBe(5);
  });

  it('GET /ops/outbox resume a fila e o retry reabre somente a linha morta', async () => {
    await drainQueue();
    const deadFixtures = await createFixtures();
    const deadId = await enqueueFor(deadFixtures);
    await markOutboxDead(pool, deadId, '400: invalid value');
    const pendingFixtures = await createFixtures();
    const pendingId = await enqueueFor(pendingFixtures);

    const admin = await tokenOf('admin@example.com');
    const summary = await app.inject({
      method: 'GET',
      url: '/api/v1/ops/outbox',
      headers: { authorization: `Bearer ${admin}` }
    });
    expect(summary.statusCode).toBe(200);
    const body = summary.json() as {
      counts: Record<string, number>;
      dead: { id: string; lastError: string | null }[];
      oldestPendingAgeSeconds: number | null;
    };
    expect(body.counts.dead).toBe(1);
    expect(body.counts.pending).toBe(1);
    expect(body.dead.map((row) => row.id)).toContain(deadId);
    expect(body.dead[0]?.lastError).toBe('400: invalid value');
    expect(body.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(0);

    const retried = await app.inject({
      method: 'POST',
      url: `/api/v1/ops/outbox/${deadId}/retry`,
      headers: { authorization: `Bearer ${admin}` }
    });
    expect(retried.statusCode).toBe(200);
    expect(await statusOf(deadId)).toMatchObject({ status: 'pending', attempts: 0, lastError: null });

    const conflict = await app.inject({
      method: 'POST',
      url: `/api/v1/ops/outbox/${pendingId}/retry`,
      headers: { authorization: `Bearer ${admin}` }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'OUTBOX_NOT_DEAD' });

    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/ops/outbox/${randomUUID()}/retry`,
      headers: { authorization: `Bearer ${admin}` }
    });
    expect(missing.statusCode).toBe(404);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/ops/outbox/nao-e-uuid/retry',
      headers: { authorization: `Bearer ${admin}` }
    });
    expect(invalid.statusCode).toBe(400);

    const viewer = await tokenOf('viewer@example.com');
    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/v1/ops/outbox/${deadId}/retry`,
      headers: { authorization: `Bearer ${viewer}` }
    });
    expect(forbidden.statusCode).toBe(403);

    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/ops/outbox' });
    expect(anonymous.statusCode).toBe(401);

    const audited = await pool.query<{ metadata: { previousError?: string } }>(
      `SELECT metadata FROM audit_logs WHERE action = 'outbox.retried' AND entity_id = $1`,
      [deadId]
    );
    expect(audited.rowCount).toBe(1);
    expect(audited.rows[0]?.metadata.previousError).toBe('400: invalid value');
  });
});
