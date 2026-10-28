import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { buildApp } from '../app.js';
import { hashPassword } from '../auth/password.js';
import { loadConfig } from '../config.js';
import { applyMigrations } from '../db/run-migrations.js';
import { runAsaasEventsCycle, type AsaasEventSettings } from './events.js';

/**
 * Integracao do consumidor de `asaas_events` (secao 8 de `docs/ASAAS_EVENT_RULES.md`).
 *
 * Mesmo harness do outbox: schema temporario, migrations reais, **nenhuma rede**. Aqui nem existe fake
 * de provedor - o evento chega completo pelo webhook e o consumidor so le e escreve no banco.
 *
 * Quem controla o relogio e o `leaseTimeoutMs`: em `RETRY_SETTINGS` ele e `0`, entao a linha volta a
 * ser elegivel no ciclo seguinte e o teste exercita o teto de tentativas sem dormir dois minutos.
 */
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describeWithDatabase = connectionString ? describe : describe.skip;
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const schemaName = `asaas_ev_it_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const PASSWORD = 'senha-de-teste-123456';

const SETTINGS: AsaasEventSettings = { batchSize: 10, leaseTimeoutMs: 300_000, maxAttempts: 3 };
/** Lease zero: a proxima tentativa sai no ciclo seguinte, o que torna o retry testavel. */
const RETRY_SETTINGS: AsaasEventSettings = { batchSize: 10, leaseTimeoutMs: 0, maxAttempts: 2 };

describeWithDatabase('integracao: consumidor de asaas_events', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;

  const tokenOf = async (email: string): Promise<string> => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
    expect(response.statusCode).toBe(200);
    return (response.json() as { accessToken: string }).accessToken;
  };

  const cycle = () => runAsaasEventsCycle({ pool, logger: app.log }, SETTINGS);

  const cycleWith = (settings: AsaasEventSettings) => runAsaasEventsCycle({ pool, logger: app.log }, settings);

  /** Evita que o evento pendente de um teste seja pego pelo ciclo do seguinte. */
  const drainEvents = async (): Promise<void> => {
    await pool.query('UPDATE asaas_events SET processed_at = now() WHERE processed_at IS NULL');
  };

  /** Cadeia minima: escola -> cliente -> acordo -> parcela, mais cliente/cobranca no provedor. */
  const seedCharge = async (status = 'PENDING') => {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
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
      [customer.rows[0]?.id, `cus_${suffix}`]
    );
    const externalChargeId = `pay_${suffix}`;
    await pool.query(
      `INSERT INTO asaas_charges (installment_id, asaas_customer_id, external_id, environment, billing_type, value, due_date, status)
       VALUES ($1, $2, $3, 'sandbox', 'BOLETO', 150.50, '2026-11-10', $4)`,
      [installment.rows[0]?.id, asaasCustomer.rows[0]?.id, externalChargeId, status]
    );
    return { installmentId: String(installment.rows[0]?.id), externalChargeId };
  };

  /** Grava o evento como o webhook gravaria; devolve o id local. */
  const receiveEvent = async (options: {
    eventType: string;
    externalChargeId: string | null;
    status?: string;
    value?: number | null;
    payment?: Record<string, unknown>;
  }): Promise<string> => {
    const payment =
      options.payment ??
      {
        id: options.externalChargeId,
        status: options.status ?? 'PENDING',
        ...(options.value === null ? {} : { value: options.value ?? 150.5 }),
        paymentDate: '2026-11-10'
      };
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO asaas_events (external_event_id, environment, event_type, external_charge_id, payload)
       VALUES ($1, 'sandbox', $2, $3, $4) RETURNING id`,
      [
        `evt_${randomUUID()}`,
        options.eventType,
        options.externalChargeId,
        { id: `evt_${randomUUID()}`, event: options.eventType, payment }
      ]
    );
    return String(inserted.rows[0]?.id);
  };

  const installmentStatus = async (id: string): Promise<string | undefined> =>
    (await pool.query<{ status: string }>('SELECT status FROM installments WHERE id = $1', [id])).rows[0]?.status;

  const paymentsOf = async (installmentId: string) =>
    (
      await pool.query<{
        status: string;
        amount: string;
        source: string;
        externalId: string | null;
        paidAt: string | null;
      }>(
        `SELECT status, amount, source, external_id AS "externalId", paid_at AS "paidAt"
           FROM payments WHERE installment_id = $1 ORDER BY created_at`,
        [installmentId]
      )
    ).rows;

  const chargeStatus = async (externalChargeId: string): Promise<string | undefined> =>
    (await pool.query<{ status: string }>('SELECT status FROM asaas_charges WHERE external_id = $1', [externalChargeId]))
      .rows[0]?.status;

  const eventRow = async (id: string) =>
    (
      await pool.query<{
        processedAt: string | null;
        failedAt: string | null;
        attempts: number;
        failureReason: string | null;
      }>(
        `SELECT processed_at AS "processedAt", failed_at AS "failedAt", attempts,
                failure_reason AS "failureReason"
           FROM asaas_events WHERE id = $1`,
        [id]
      )
    ).rows[0];

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

  it('PAYMENT_CONFIRMED aplica parcela, lancamento, cobranca e auditoria', async () => {
    await drainEvents();
    const charge = await seedCharge();
    const eventId = await receiveEvent({
      eventType: 'PAYMENT_CONFIRMED',
      externalChargeId: charge.externalChargeId,
      status: 'CONFIRMED'
    });

    const result = await cycle();
    expect(result).toMatchObject({ claimed: 1, applied: 1, stale: 0, ignored: 0, orphan: 0, retried: 0, failed: 0 });

    expect(await installmentStatus(charge.installmentId)).toBe('paid');
    expect(await chargeStatus(charge.externalChargeId)).toBe('CONFIRMED');

    const payments = await paymentsOf(charge.installmentId);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'confirmed', source: 'asaas', externalId: charge.externalChargeId });
    expect(payments[0]?.amount).toBe('150.50');
    expect(payments[0]?.paidAt).not.toBeNull();

    const row = await eventRow(eventId);
    expect(row).toMatchObject({ attempts: 1, failedAt: null, failureReason: null });
    expect(row?.processedAt).not.toBeNull();

    const audit = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      'SELECT action, metadata FROM audit_logs WHERE entity_id = $1',
      [charge.installmentId]
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.action).toBe('installment.status_changed');
    expect(audit.rows[0]?.metadata).toMatchObject({ from: 'pending', to: 'paid', paymentStatus: 'confirmed' });
  });

  it('PAYMENT_RECEIVED depois de CONFIRMED sobe o mesmo lancamento para paid', async () => {
    await drainEvents();
    const charge = await seedCharge();
    await receiveEvent({ eventType: 'PAYMENT_CONFIRMED', externalChargeId: charge.externalChargeId, status: 'CONFIRMED' });
    await cycle();

    await receiveEvent({ eventType: 'PAYMENT_RECEIVED', externalChargeId: charge.externalChargeId, status: 'RECEIVED' });
    const result = await cycle();
    expect(result.applied).toBe(1);

    const payments = await paymentsOf(charge.installmentId);
    expect(payments).toHaveLength(1);
    expect(payments[0]?.status).toBe('paid');
    expect(await chargeStatus(charge.externalChargeId)).toBe('RECEIVED');
  });

  it('ordem invertida: RECEIVED aplica primeiro e o CONFIRMED atrasado vira stale', async () => {
    await drainEvents();
    const charge = await seedCharge();
    const confirmedId = await receiveEvent({
      eventType: 'PAYMENT_CONFIRMED',
      externalChargeId: charge.externalChargeId,
      status: 'CONFIRMED'
    });
    const receivedId = await receiveEvent({
      eventType: 'PAYMENT_RECEIVED',
      externalChargeId: charge.externalChargeId,
      status: 'RECEIVED'
    });
    // O provedor entrega fora de ordem: o RECEIVED chegou antes na fila, mesmo gravado depois.
    await pool.query(`UPDATE asaas_events SET created_at = now() - interval '2 seconds' WHERE id = $1`, [receivedId]);
    await pool.query(`UPDATE asaas_events SET created_at = now() - interval '1 second' WHERE id = $1`, [confirmedId]);

    const result = await cycle();
    expect(result).toMatchObject({ claimed: 2, applied: 1, stale: 1 });

    expect(await installmentStatus(charge.installmentId)).toBe('paid');
    expect((await paymentsOf(charge.installmentId))[0]?.status).toBe('paid');
    expect((await eventRow(confirmedId))?.processedAt).not.toBeNull();
    expect((await eventRow(receivedId))?.processedAt).not.toBeNull();
    // Cobranca continua com o ultimo status do provedor, nao com o evento descartado.
    expect(await chargeStatus(charge.externalChargeId)).toBe('CONFIRMED');
  });

  it('PAYMENT_OVERDUE deixa a parcela overdue e nao cria lancamento', async () => {
    await drainEvents();
    const charge = await seedCharge();
    await receiveEvent({ eventType: 'PAYMENT_OVERDUE', externalChargeId: charge.externalChargeId, status: 'OVERDUE' });

    expect((await cycle()).applied).toBe(1);
    expect(await installmentStatus(charge.installmentId)).toBe('overdue');
    expect(await paymentsOf(charge.installmentId)).toHaveLength(0);
    expect(await chargeStatus(charge.externalChargeId)).toBe('OVERDUE');
  });

  it('PAYMENT_REFUNDED estorna e o RECEIVED atrasado nao reabre a parcela', async () => {
    await drainEvents();
    const charge = await seedCharge('RECEIVED');
    await receiveEvent({ eventType: 'PAYMENT_RECEIVED', externalChargeId: charge.externalChargeId, status: 'RECEIVED' });
    await cycle();
    await receiveEvent({ eventType: 'PAYMENT_REFUNDED', externalChargeId: charge.externalChargeId, status: 'REFUNDED' });
    expect((await cycle()).applied).toBe(1);

    expect(await installmentStatus(charge.installmentId)).toBe('refunded');
    expect((await paymentsOf(charge.installmentId))[0]?.status).toBe('refunded');

    const lateId = await receiveEvent({
      eventType: 'PAYMENT_RECEIVED',
      externalChargeId: charge.externalChargeId,
      status: 'RECEIVED'
    });
    const result = await cycle();
    expect(result).toMatchObject({ applied: 0, stale: 1 });
    expect(await installmentStatus(charge.installmentId)).toBe('refunded');
    expect((await paymentsOf(charge.installmentId))[0]?.status).toBe('refunded');
    // O no-op tambem fecha o evento: nada a reprocessar depois.
    expect((await eventRow(lateId))?.processedAt).not.toBeNull();
  });

  it('PAYMENT_DELETED cancela e PAYMENT_RESTORED devolve a parcela para pending', async () => {
    await drainEvents();
    const charge = await seedCharge();
    await receiveEvent({ eventType: 'PAYMENT_DELETED', externalChargeId: charge.externalChargeId, status: 'DELETED' });
    expect((await cycle()).applied).toBe(1);
    expect(await installmentStatus(charge.installmentId)).toBe('canceled');

    await receiveEvent({ eventType: 'PAYMENT_RESTORED', externalChargeId: charge.externalChargeId, status: 'PENDING' });
    expect((await cycle()).applied).toBe(1);
    expect(await installmentStatus(charge.installmentId)).toBe('pending');
    expect(await paymentsOf(charge.installmentId)).toHaveLength(0);
  });

  it('evento fora do mapa vira ignored e nao mexe em nada', async () => {
    await drainEvents();
    const charge = await seedCharge();
    const eventId = await receiveEvent({
      eventType: 'PAYMENT_CREATED',
      externalChargeId: charge.externalChargeId,
      status: 'PENDING'
    });

    const result = await cycle();
    expect(result).toMatchObject({ applied: 0, ignored: 1, retried: 0, failed: 0 });
    expect(await installmentStatus(charge.installmentId)).toBe('pending');
    expect(await paymentsOf(charge.installmentId)).toHaveLength(0);
    expect((await eventRow(eventId))?.processedAt).not.toBeNull();
  });

  it('cobranca desconhecida vira orphan com failure_reason e sem retry', async () => {
    await drainEvents();
    const eventId = await receiveEvent({
      eventType: 'PAYMENT_RECEIVED',
      externalChargeId: `pay_inexistente_${randomUUID().slice(0, 8)}`,
      status: 'RECEIVED'
    });

    const result = await cycle();
    expect(result).toMatchObject({ claimed: 1, orphan: 1, retried: 0, failed: 0 });
    const row = await eventRow(eventId);
    expect(row?.processedAt).not.toBeNull();
    expect(row?.failureReason).toBe('charge not found');

    // Reaplicar o ciclo nao pega de novo: `processed_at` fechou a linha.
    expect((await cycle()).claimed).toBe(0);
  });

  it('payload invalido consome tentativas, morre no teto e volta pela mao do operador', async () => {
    await drainEvents();
    const eventId = await receiveEvent({
      eventType: 'PAYMENT_RECEIVED',
      externalChargeId: 'pay_sem_id',
      payment: { status: 'RECEIVED' }
    });

    const first = await cycleWith(RETRY_SETTINGS);
    expect(first).toMatchObject({ claimed: 1, retried: 1, failed: 0 });
    expect(await eventRow(eventId)).toMatchObject({ attempts: 1, failedAt: null });

    const second = await cycleWith(RETRY_SETTINGS);
    expect(second).toMatchObject({ claimed: 1, retried: 0, failed: 1 });
    const dead = await eventRow(eventId);
    expect(dead?.failedAt).not.toBeNull();
    expect(dead?.failureReason).toContain('payload invalido');

    // Teto atingido: a linha sai do claim e so volta por `POST /ops/asaas-events/:id/retry`.
    expect((await cycleWith(RETRY_SETTINGS)).claimed).toBe(0);

    const admin = await tokenOf('admin@example.com');
    const retried = await app.inject({
      method: 'POST',
      url: `/api/v1/ops/asaas-events/${eventId}/retry`,
      headers: { authorization: `Bearer ${admin}` }
    });
    expect(retried.statusCode).toBe(200);
    expect(await eventRow(eventId)).toMatchObject({ attempts: 0, failedAt: null, failureReason: null });
  });

  it('reaplicar o mesmo evento nao cria segundo lancamento', async () => {
    await drainEvents();
    const charge = await seedCharge();
    const receivedId = await receiveEvent({
      eventType: 'PAYMENT_RECEIVED',
      externalChargeId: charge.externalChargeId,
      status: 'RECEIVED'
    });
    await cycle();
    expect(await paymentsOf(charge.installmentId)).toHaveLength(1);

    // Reprocessamento manual: o mesmo evento volta para a fila com os mesmos dados.
    await pool.query('UPDATE asaas_events SET processed_at = NULL, attempts = 0 WHERE id = $1', [receivedId]);
    expect((await cycle()).applied).toBe(1);

    const payments = await paymentsOf(charge.installmentId);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'paid', source: 'asaas', externalId: charge.externalChargeId });
    expect(await installmentStatus(charge.installmentId)).toBe('paid');
  });

  it('GET /ops/asaas-events resume a entrada e o retry so aceita evento falho', async () => {
    await drainEvents();
    const failedId = await receiveEvent({
      eventType: 'PAYMENT_RECEIVED',
      externalChargeId: 'pay_sem_id_2',
      payment: {}
    });
    await cycleWith(RETRY_SETTINGS);
    await cycleWith(RETRY_SETTINGS);
    expect((await eventRow(failedId))?.failedAt).not.toBeNull();

    // Pendente de verdade: gravado depois do ultimo ciclo, ninguem reivindicou.
    const pendingId = await receiveEvent({
      eventType: 'PAYMENT_CREATED',
      externalChargeId: `pay_pendente_${randomUUID().slice(0, 8)}`
    });

    const admin = await tokenOf('admin@example.com');
    const summary = await app.inject({
      method: 'GET',
      url: '/api/v1/ops/asaas-events',
      headers: { authorization: `Bearer ${admin}` }
    });
    expect(summary.statusCode).toBe(200);
    const body = summary.json() as {
      counts: Record<string, number>;
      failed: { id: string; eventType: string; failureReason: string | null }[];
      oldestPendingAgeSeconds: number | null;
    };
    expect(body.counts.failed).toBeGreaterThanOrEqual(1);
    expect(body.counts.pending).toBeGreaterThanOrEqual(1);
    expect(body.failed.map((row) => row.id)).toContain(failedId);
    expect(body.failed.find((row) => row.id === failedId)?.failureReason).toContain('payload invalido');
    expect(body.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(0);

    const conflict = await app.inject({
      method: 'POST',
      url: `/api/v1/ops/asaas-events/${pendingId}/retry`,
      headers: { authorization: `Bearer ${admin}` }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'ASAAS_EVENT_NOT_FAILED' });

    const missing = await app.inject({
      method: 'POST',
      url: `/api/v1/ops/asaas-events/${randomUUID()}/retry`,
      headers: { authorization: `Bearer ${admin}` }
    });
    expect(missing.statusCode).toBe(404);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/ops/asaas-events/nao-e-uuid/retry',
      headers: { authorization: `Bearer ${admin}` }
    });
    expect(invalid.statusCode).toBe(400);

    const viewer = await tokenOf('viewer@example.com');
    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/v1/ops/asaas-events/${failedId}/retry`,
      headers: { authorization: `Bearer ${viewer}` }
    });
    expect(forbidden.statusCode).toBe(403);

    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/ops/asaas-events' });
    expect(anonymous.statusCode).toBe(401);

    const reopened = await app.inject({
      method: 'POST',
      url: `/api/v1/ops/asaas-events/${failedId}/retry`,
      headers: { authorization: `Bearer ${admin}` }
    });
    expect(reopened.statusCode).toBe(200);

    const audited = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_logs WHERE action = 'asaas_event.retried' AND entity_id = $1`,
      [failedId]
    );
    expect(audited.rowCount).toBe(1);
    expect(audited.rows[0]?.metadata.eventType).toBe('PAYMENT_RECEIVED');
  });
});
