import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { applyMigrations } from './db/run-migrations.js';
import { patchRow } from './db/patch.js';
import { hashPassword } from './auth/password.js';

/**
 * Testes de integracao com PostgreSQL descartavel.
 *
 * O banco vem de `TEST_DATABASE_URL` (sem ela o bloco inteiro e ignorado, para `npm test` seguir
 * verde em maquina sem banco). As migrations rodam num **schema temporario** com `search_path`
 * apontando para ele, entao o banco escolhido nao e alterado: o schema e removido no `afterAll`.
 *
 *   docker exec voa-staging createdb -U postgres voa_api_test
 *   $env:TEST_DATABASE_URL = "postgresql://postgres:SENHA@localhost:5434/voa_api_test"
 *   npm run test:integration
 */
const connectionString = process.env.TEST_DATABASE_URL?.trim();
const describeWithDatabase = connectionString ? describe : describe.skip;
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
const schemaName = `api_it_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const PASSWORD = 'senha-de-teste-123456';
const USERS = [
  { email: 'admin@example.com', role: 'admin' },
  { email: 'finance@example.com', role: 'finance' },
  { email: 'viewer@example.com', role: 'viewer' }
] as const;

describeWithDatabase('integracao: autenticacao, rotacao de refresh, RBAC e auditoria', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof buildApp>;

  const login = async (email: string, password: string = PASSWORD) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });

  const accessTokenOf = async (email: string): Promise<string> => {
    const response = await login(email);
    expect(response.statusCode).toBe(200);
    return (response.json() as { accessToken: string }).accessToken;
  };

  const refreshCookieOf = (response: LightMyRequestResponse): string => {
    const header = response.headers['set-cookie'];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value) throw new Error('response has no refresh cookie');
    return value.split(';')[0] ?? '';
  };

  const setCookieHeaderOf = (response: LightMyRequestResponse): string => {
    const header = response.headers['set-cookie'];
    return Array.isArray(header) ? header.join(';') : String(header);
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString, max: 4, options: `-c search_path=${schemaName}` });
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await applyMigrations(pool, migrationsDirectory);
    for (const { email, role } of USERS) {
      await pool.query('INSERT INTO roles (name, description) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [role, role]);
      const inserted = await pool.query<{ id: string }>(
        'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id',
        [email, await hashPassword(PASSWORD), role]
      );
      const user = inserted.rows[0];
      if (!user) throw new Error(`could not create ${email}`);
      await pool.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = $2', [user.id, role]);
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

  it('recusa credenciais invalidas e registra a tentativa em audit_logs', async () => {
    const response = await login('admin@example.com', 'senha-errada');
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const audited = await pool.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM audit_logs WHERE action = 'auth.login.failed'"
    );
    expect(audited.rows[0]?.total).toBeGreaterThan(0);
  });

  it('autentica, entrega o cookie httpOnly e responde /auth/me com os papeis', async () => {
    const response = await login('admin@example.com');
    expect(response.statusCode).toBe(200);
    const body = response.json() as { accessToken: string; tokenType: string; expiresIn: number };
    expect(body.tokenType).toBe('Bearer');
    expect(body.expiresIn).toBe(900);

    const raw = setCookieHeaderOf(response);
    expect(raw).toContain('voa_refresh=');
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).toContain('Path=/api/v1/auth');

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${body.accessToken}` }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { roles: ['admin'] } });
  });

  it('rotaciona o refresh token e recusa o token reaproveitado', async () => {
    const session = await login('viewer@example.com');
    const firstCookie = refreshCookieOf(session);

    const rotated = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: firstCookie } });
    expect(rotated.statusCode).toBe(200);
    const secondCookie = refreshCookieOf(rotated);
    expect(secondCookie).not.toBe(firstCookie);

    const replay = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: firstCookie } });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ code: 'UNAUTHORIZED' });

    const rotatedAgain = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: secondCookie } });
    expect(rotatedAgain.statusCode).toBe(200);

    const audited = await pool.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM audit_logs WHERE action = 'auth.refresh.rejected'"
    );
    expect(audited.rows[0]?.total).toBeGreaterThan(0);

    const withoutCookie = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh' });
    expect(withoutCookie.statusCode).toBe(401);
  });

  it('nega escrita ao viewer e libera leitura', async () => {
    const token = await accessTokenOf('viewer@example.com');
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers: { authorization: `Bearer ${token}` },
      payload: { fullName: 'Cliente Proibido' }
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: 'FORBIDDEN' });

    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/customers',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(read.statusCode).toBe(200);
  });

  it('cria escola, cliente, aluno e contato como admin, lista e audita', async () => {
    const headers = { authorization: `Bearer ${await accessTokenOf('admin@example.com')}` };
    const school = await app.inject({ method: 'POST', url: '/api/v1/schools', headers, payload: { legalName: 'Colegio Teste' } });
    expect(school.statusCode).toBe(201);
    const schoolId = (school.json() as { id: string }).id;

    const customer = await app.inject({
      method: 'POST',
      url: '/api/v1/customers',
      headers,
      payload: { fullName: 'Maria Teste', email: 'maria@example.com' }
    });
    expect(customer.statusCode).toBe(201);
    const customerId = (customer.json() as { id: string }).id;

    const student = await app.inject({
      method: 'POST',
      url: '/api/v1/students',
      headers,
      payload: { schoolId, customerId, fullName: 'Aluno Teste' }
    });
    expect(student.statusCode).toBe(201);

    const contact = await app.inject({
      method: 'POST',
      url: `/api/v1/customers/${customerId}/contacts`,
      headers,
      payload: { type: 'phone', value: '11999999999', isPrimary: true }
    });
    expect(contact.statusCode).toBe(201);

    const listed = await app.inject({ method: 'GET', url: '/api/v1/customers?search=Maria%20Teste', headers });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: { id: string }[] }).items.map((item) => item.id)).toContain(customerId);

    const audited = await pool.query<{ action: string }>('SELECT action FROM audit_logs WHERE entity_id = $1::uuid', [customerId]);
    expect(audited.rows.map((row) => row.action)).toContain('customer.created');
  });

  it('exige a permissao finance:write na cadeia financeira', async () => {
    const adminHeaders = { authorization: `Bearer ${await accessTokenOf('admin@example.com')}` };
    const financeHeaders = { authorization: `Bearer ${await accessTokenOf('finance@example.com')}` };
    const viewerHeaders = { authorization: `Bearer ${await accessTokenOf('viewer@example.com')}` };

    const school = await app.inject({ method: 'POST', url: '/api/v1/schools', headers: adminHeaders, payload: { legalName: 'Colegio Financeiro' } });
    const customer = await app.inject({ method: 'POST', url: '/api/v1/customers', headers: adminHeaders, payload: { fullName: 'Cliente Financeiro' } });
    const agreement = await app.inject({
      method: 'POST',
      url: '/api/v1/agreements',
      headers: financeHeaders,
      payload: {
        schoolId: (school.json() as { id: string }).id,
        customerId: (customer.json() as { id: string }).id,
        totalAmount: 300,
        installmentsCount: 3
      }
    });
    expect(agreement.statusCode).toBe(201);

    const installment = await app.inject({
      method: 'POST',
      url: '/api/v1/installments',
      headers: financeHeaders,
      payload: {
        agreementId: (agreement.json() as { id: string }).id,
        installmentNumber: 1,
        dueDate: '2026-10-10',
        originalAmount: 100
      }
    });
    expect(installment.statusCode).toBe(201);

    const paymentPayload = { installmentId: (installment.json() as { id: string }).id, amount: 50, source: 'manual' };
    const forbidden = await app.inject({ method: 'POST', url: '/api/v1/payments', headers: viewerHeaders, payload: paymentPayload });
    expect(forbidden.statusCode).toBe(403);

    const payment = await app.inject({ method: 'POST', url: '/api/v1/payments', headers: financeHeaders, payload: paymentPayload });
    expect(payment.statusCode).toBe(201);
    expect(payment.json()).toMatchObject({ status: 'paid' });
  });

  it('expoe audit_logs somente para o admin', async () => {
    const viewerHeaders = { authorization: `Bearer ${await accessTokenOf('viewer@example.com')}` };
    const adminHeaders = { authorization: `Bearer ${await accessTokenOf('admin@example.com')}` };

    const forbidden = await app.inject({ method: 'GET', url: '/api/v1/audit-logs', headers: viewerHeaders });
    expect(forbidden.statusCode).toBe(403);

    const allowed = await app.inject({ method: 'GET', url: '/api/v1/audit-logs?action=auth.login.succeeded', headers: adminHeaders });
    expect(allowed.statusCode).toBe(200);
    const items = (allowed.json() as { items: { action: string }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.action === 'auth.login.succeeded')).toBe(true);
  });

  it('revoga a sessao no logout e limpa o cookie', async () => {
    const session = await login('viewer@example.com');
    const cookie = refreshCookieOf(session);
    const token = (session.json() as { accessToken: string }).accessToken;

    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${token}`, cookie }
    });
    expect(out.statusCode).toBe(204);
    expect(setCookieHeaderOf(out)).toContain('Max-Age=0');

    const afterLogout = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie } });
    expect(afterLogout.statusCode).toBe(401);
  });

  describe('PATCH parcial', () => {
    const adminHeaders = async () => ({ authorization: `Bearer ${await accessTokenOf('admin@example.com')}` });
    const financeHeaders = async () => ({ authorization: `Bearer ${await accessTokenOf('finance@example.com')}` });
    const viewerHeaders = async () => ({ authorization: `Bearer ${await accessTokenOf('viewer@example.com')}` });

    /** Cria escola -> cliente -> acordo -> parcela -> pagamento e devolve os ids. */
    const seedPayment = async (headers: Record<string, string>) => {
      const suffix = randomUUID().slice(0, 8);
      const catalog = await adminHeaders();
      const create = async (url: string, payload: Record<string, unknown>, auth: Record<string, string>) => {
        const response = await app.inject({ method: 'POST', url, headers: auth, payload });
        expect({ url, statusCode: response.statusCode, body: response.body }).toMatchObject({ url, statusCode: 201 });
        return response.json() as { id: string };
      };
      const school = await create('/api/v1/schools', { legalName: `Colegio Patch ${suffix}` }, catalog);
      const customer = await create('/api/v1/customers', { fullName: `Cliente Patch ${suffix}` }, catalog);
      const agreement = await create('/api/v1/agreements', {
        schoolId: school.id, customerId: customer.id, totalAmount: 100, installmentsCount: 1
      }, headers);
      const installment = await create('/api/v1/installments', {
        agreementId: agreement.id, installmentNumber: 1, dueDate: '2026-11-10', originalAmount: 100
      }, headers);
      const payment = await create('/api/v1/payments', { installmentId: installment.id, amount: 100, source: 'manual' }, headers);
      return { schoolId: school.id, customerId: customer.id, agreementId: agreement.id, installmentId: installment.id, paymentId: payment.id };
    };

    it('atualiza apenas os campos enviados e audita customer.updated', async () => {
      const headers = await adminHeaders();
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/customers',
        headers,
        payload: { fullName: 'Cliente Parcial', documentNumber: '123', phone: '+55 11 90000-0000' }
      });
      expect(created.statusCode).toBe(201);
      const customer = created.json() as { id: string; createdAt: string; updatedAt: string };

      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/v1/customers/${customer.id}`,
        headers,
        payload: { fullName: 'Cliente Parcial II', phone: null, email: 'Parcial@Example.COM' }
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({
        id: customer.id,
        fullName: 'Cliente Parcial II',
        phone: null,
        documentNumber: '123',
        email: 'parcial@example.com'
      });
      const body = patched.json() as { createdAt: string; updatedAt: string };
      expect(body.createdAt).toBe(customer.createdAt);
      // `updated_at` compara no banco: o driver devolve timestamptz so com milissegundos.
      const renewed = await pool.query<{ renewed: boolean }>(
        'SELECT updated_at > created_at AS renewed FROM customers WHERE id = $1', [customer.id]);
      expect(renewed.rows[0]?.renewed).toBe(true);

      const audited = await pool.query<{ metadata: { actorId?: string; fields: string[] } }>(
        `SELECT metadata FROM audit_logs WHERE action = 'customer.updated' AND entity_id = $1`, [customer.id]);
      expect(audited.rows).toHaveLength(1);
      expect([...(audited.rows[0]?.metadata.fields ?? [])].sort()).toEqual(['email', 'fullName', 'phone']);
      expect(audited.rows[0]?.metadata.actorId).toBeTruthy();
    });

    it('recusa corpo vazio, campo desconhecido, id invalido e linha inexistente', async () => {
      const headers = await adminHeaders();
      const created = await app.inject({ method: 'POST', url: '/api/v1/schools', headers, payload: { legalName: 'Colegio Patch' } });
      const school = created.json() as { id: string };

      const empty = await app.inject({ method: 'PATCH', url: `/api/v1/schools/${school.id}`, headers, payload: {} });
      expect(empty.statusCode).toBe(400);
      expect(empty.json()).toMatchObject({ code: 'EMPTY_PATCH' });

      const unknown = await app.inject({ method: 'PATCH', url: `/api/v1/schools/${school.id}`, headers, payload: { legal_name: 'Colegio' } });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json()).toMatchObject({ code: 'INVALID_REQUEST' });

      const invalidId = await app.inject({ method: 'PATCH', url: '/api/v1/schools/nao-e-uuid', headers, payload: { legalName: 'Colegio Patch' } });
      expect(invalidId.statusCode).toBe(400);

      const missing = await app.inject({
        method: 'PATCH', url: `/api/v1/schools/${randomUUID()}`, headers, payload: { legalName: 'Colegio Patch' }
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('nao atualiza linha apagada logicamente', async () => {
      const headers = await adminHeaders();
      const created = await app.inject({ method: 'POST', url: '/api/v1/customers', headers, payload: { fullName: 'Cliente Removido' } });
      const customer = created.json() as { id: string };
      await pool.query('UPDATE customers SET deleted_at = now() WHERE id = $1', [customer.id]);

      const patched = await app.inject({
        method: 'PATCH', url: `/api/v1/customers/${customer.id}`, headers, payload: { fullName: 'Cliente Removido II' }
      });
      expect(patched.statusCode).toBe(404);
      const stored = await pool.query<{ full_name: string }>('SELECT full_name FROM customers WHERE id = $1', [customer.id]);
      expect(stored.rows[0]?.full_name).toBe('Cliente Removido');
    });

    it('exige catalog:write no catalogo e finance:write na cadeia financeira', async () => {
      const admin = await adminHeaders();
      const finance = await financeHeaders();
      const viewer = await viewerHeaders();
      const { schoolId, customerId, paymentId } = await seedPayment(finance);

      const cases = [
        { url: `/api/v1/schools/${schoolId}`, headers: viewer, payload: { legalName: 'Colegio Vetado' } },
        { url: `/api/v1/customers/${customerId}`, headers: finance, payload: { fullName: 'Cliente Vetado' } },
        { url: `/api/v1/payments/${paymentId}`, headers: viewer, payload: { retentionStatus: 'approved' } }
      ];
      for (const { url, headers, payload } of cases) {
        const forbidden = await app.inject({ method: 'PATCH', url, headers, payload });
        expect({ url, statusCode: forbidden.statusCode }).toEqual({ url, statusCode: 403 });
      }

      const byFinance = await app.inject({
        method: 'PATCH', url: `/api/v1/payments/${paymentId}`, headers: finance, payload: { retentionStatus: 'approved' }
      });
      expect(byFinance.statusCode).toBe(200);
      expect(byFinance.json()).toMatchObject({ retentionStatus: 'approved' });

      const byAdmin = await app.inject({
        method: 'PATCH', url: `/api/v1/schools/${schoolId}`, headers: admin, payload: { legalName: 'Colegio RBAC II', retentionEnabled: true }
      });
      expect(byAdmin.statusCode).toBe(200);
      expect(byAdmin.json()).toMatchObject({ legalName: 'Colegio RBAC II', retentionEnabled: true });
    });

    it('grava, valida e limpa os campos de retencao do pagamento', async () => {
      const headers = await financeHeaders();
      const { paymentId, installmentId } = await seedPayment(headers);

      const approved = await app.inject({
        method: 'PATCH',
        url: `/api/v1/payments/${paymentId}`,
        headers,
        payload: {
          retentionStatus: 'approved',
          retentionPercentage: 0.25,
          retentionApprovedAt: '2026-10-01',
          retentionScheduledMonth: '2026-11'
        }
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({
        id: paymentId,
        retentionStatus: 'approved',
        retentionPercentage: '0.2500',
        retentionScheduledMonth: '2026-11',
        retentionReleasedAt: null
      });

      const refusedPayloads = [
        { retentionScheduledMonth: '2026-13' },
        { retentionPercentage: 1.5 },
        { retentionStatus: 'aprovado' },
        { retainedAmount: -1 }
      ];
      for (const payload of refusedPayloads) {
        const refused = await app.inject({ method: 'PATCH', url: `/api/v1/payments/${paymentId}`, headers, payload });
        expect({ payload, statusCode: refused.statusCode }).toEqual({ payload, statusCode: 400 });
      }

      // `null` limpa a coluna; o que nao veio no corpo continua com o valor anterior.
      const cleared = await app.inject({
        method: 'PATCH',
        url: `/api/v1/payments/${paymentId}`,
        headers,
        payload: { retentionStatus: null, retentionPercentage: null, retentionScheduledMonth: null }
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json()).toMatchObject({ retentionStatus: null, retentionPercentage: null, retentionScheduledMonth: null });

      const stored = await pool.query<{ status: string | null; approved_at: string | null; released_at: string | null }>(
        `SELECT retention_status AS status, retention_approved_at::text AS approved_at, retention_released_at::text AS released_at
           FROM payments WHERE id = $1`,
        [paymentId]);
      expect(stored.rows[0]).toEqual({ status: null, approved_at: '2026-10-01', released_at: null });

      const listed = await app.inject({ method: 'GET', url: `/api/v1/payments?installmentId=${installmentId}`, headers });
      expect(listed.statusCode).toBe(200);
      const items = (listed.json() as { items: Record<string, unknown>[] }).items;
      expect(items[0]).toMatchObject({ id: paymentId, retentionStatus: null, retentionPercentage: null });
      expect(items[0]).toHaveProperty('retentionScheduledMonth');
    });
  });

  describe('patchRow', () => {
    const installmentsTarget = { table: 'installments', returning: 'id', softDelete: true } as const;

    /** Cadeia minima inserida direto no banco: as constraints so existem no PostgreSQL. */
    const seed = async () => {
      const suffix = randomUUID().slice(0, 8);
      const school = await pool.query<{ id: string }>(
        'INSERT INTO schools (legal_name) VALUES ($1) RETURNING id', [`Colegio patchRow ${suffix}`]);
      const customer = await pool.query<{ id: string }>(
        'INSERT INTO customers (full_name) VALUES ($1) RETURNING id', [`Cliente patchRow ${suffix}`]);
      const schoolId = school.rows[0]?.id;
      const customerId = customer.rows[0]?.id;
      if (!schoolId || !customerId) throw new Error('seed failed');
      const agreement = await pool.query<{ id: string }>(
        'INSERT INTO agreements (school_id, customer_id, total_amount, installments_count) VALUES ($1, $2, 10, 2) RETURNING id',
        [schoolId, customerId]);
      const agreementId = agreement.rows[0]?.id;
      if (!agreementId) throw new Error('seed failed');
      const installments = await pool.query<{ id: string }>(
        `INSERT INTO installments (agreement_id, installment_number, due_date, original_amount)
         VALUES ($1, 1, '2026-11-10', 5), ($1, 2, '2026-12-10', 5) RETURNING id`,
        [agreementId]);
      const [firstInstallmentId, secondInstallmentId] = installments.rows.map((row) => row.id);
      const student = await pool.query<{ id: string }>(
        `INSERT INTO students (school_id, full_name) VALUES ($1, $2) RETURNING id`,
        [schoolId, `Aluno patchRow ${suffix}`]);
      if (!firstInstallmentId || !secondInstallmentId) throw new Error('seed failed');
      const payment = await pool.query<{ id: string }>(
        'INSERT INTO payments (installment_id, amount) VALUES ($1, 5) RETURNING id', [firstInstallmentId]);
      const paymentId = payment.rows[0]?.id;
      const studentId = student.rows[0]?.id;
      if (!paymentId || !studentId) throw new Error('seed failed');
      return { schoolId, agreementId, firstInstallmentId, secondInstallmentId, studentId, paymentId };
    };

    it('atualiza a linha, renova updated_at e ignora linha apagada', async () => {
      const { schoolId, firstInstallmentId } = await seed();
      const target = {
        table: 'schools',
        returning: 'id, legal_name AS "legalName", created_at AS "createdAt", updated_at AS "updatedAt"',
        softDelete: true
      };
      const outcome = await patchRow(pool, target, schoolId, { legal_name: 'Colegio Renomeado' });
      expect(outcome.status).toBe('updated');
      if (outcome.status !== 'updated') throw new Error('unexpected outcome');
      expect(outcome.row).toMatchObject({ id: schoolId, legalName: 'Colegio Renomeado' });
      const renewed = await pool.query<{ renewed: boolean }>(
        'SELECT updated_at > created_at AS renewed FROM schools WHERE id = $1', [schoolId]);
      expect(renewed.rows[0]?.renewed).toBe(true);

      await pool.query('UPDATE installments SET deleted_at = now() WHERE id = $1', [firstInstallmentId]);
      expect(await patchRow(pool, installmentsTarget, firstInstallmentId, { due_date: '2026-12-01' }))
        .toEqual({ status: 'not_found' });
      expect(await patchRow(pool, installmentsTarget, randomUUID(), { due_date: '2026-12-01' }))
        .toEqual({ status: 'not_found' });
      await expect(patchRow(pool, installmentsTarget, firstInstallmentId, {}))
        .rejects.toThrow('patchRow needs at least one column');
    });

    it('traduz unique, foreign key e check em resultados distintos', async () => {
      const { agreementId, secondInstallmentId, studentId, paymentId } = await seed();
      const first = await pool.query<{ id: string }>(
        'SELECT id FROM installments WHERE agreement_id = $1 AND installment_number = 1', [agreementId]);
      const firstId = first.rows[0]?.id;
      if (!firstId) throw new Error('seed failed');

      // installment_number 2 ja existe neste acordo -> unique (agreement_id, installment_number)
      expect(await patchRow(pool, installmentsTarget, firstId, { installment_number: 2 }))
        .toEqual({ status: 'conflict' });
      expect(secondInstallmentId).toBeTruthy();

      // escola inexistente -> foreign key
      expect(await patchRow(pool, { table: 'students', returning: 'id', softDelete: true }, studentId, { school_id: randomUUID() }))
        .toEqual({ status: 'invalid_reference' });

      // amount > 0 e CHECK de payments
      expect(await patchRow(pool, { table: 'payments', returning: 'id', softDelete: false }, paymentId, { amount: -1 }))
        .toEqual({ status: 'invalid_value' });
    });
  });
});
