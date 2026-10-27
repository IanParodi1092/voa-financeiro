import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
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

    it('promove o guardiao a cliente e alterna o contato do aluno', async () => {
      const headers = await adminHeaders();
      const finance = await financeHeaders();
      const viewer = await viewerHeaders();
      const { schoolId, customerId, agreementId } = await seedPayment(finance);

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/students',
        headers,
        payload: { schoolId, customerId, fullName: `Aluno Guardiao ${randomUUID().slice(0, 6)}` }
      });
      expect(created.statusCode).toBe(201);
      const studentId = (created.json() as { id: string }).id;

      // `guardians` e `student_contacts` nascem da migracao, nao de `POST`: o cenario insere direto.
      const guardianId = randomUUID();
      const contactId = randomUUID();
      await pool.query(
        'INSERT INTO guardians (id, student_id, full_name, marital_status) VALUES ($1, $2, $3, $4)',
        [guardianId, studentId, 'Responsavel Teste', 'Casada']
      );
      await pool.query(
        "INSERT INTO student_contacts (id, student_id, type, value, status) VALUES ($1, $2, 'phone', '+55 11 90000-0001', 'active')",
        [contactId, studentId]
      );

      const listed = await app.inject({ method: 'GET', url: `/api/v1/students/${studentId}/guardians`, headers });
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({ items: [{ id: guardianId, customerId: null, isFinancial: true }] });

      const promoted = await app.inject({
        method: 'PATCH',
        url: `/api/v1/guardians/${guardianId}`,
        headers,
        payload: { customerId, isVerified: true, maritalStatus: 'Casada' }
      });
      expect(promoted.statusCode).toBe(200);
      expect(promoted.json()).toMatchObject({ id: guardianId, customerId, isVerified: true, fullName: 'Responsavel Teste' });

      const unlinked = await app.inject({
        method: 'PATCH', url: `/api/v1/guardians/${guardianId}`, headers, payload: { customerId: null }
      });
      expect(unlinked.statusCode).toBe(200);
      expect(unlinked.json()).toMatchObject({ customerId: null });

      const contacts = await app.inject({ method: 'GET', url: `/api/v1/students/${studentId}/contacts`, headers });
      expect(contacts.statusCode).toBe(200);
      expect(contacts.json()).toMatchObject({ items: [{ id: contactId, type: 'phone', status: 'active' }] });

      const deactivated = await app.inject({
        method: 'PATCH', url: `/api/v1/student-contacts/${contactId}`, headers, payload: { status: 'inactive' }
      });
      expect(deactivated.statusCode).toBe(200);
      expect(deactivated.json()).toMatchObject({ id: contactId, status: 'inactive' });

      // `viewer` le mas nao escreve no catalogo.
      const viewerRead = await app.inject({ method: 'GET', url: `/api/v1/students/${studentId}/contacts`, headers: viewer });
      expect(viewerRead.statusCode).toBe(200);
      const forbidden = await app.inject({
        method: 'PATCH', url: `/api/v1/guardians/${guardianId}`, headers: viewer, payload: { isVerified: false }
      });
      expect(forbidden.statusCode).toBe(403);

      // `closedAt` fecha e reabre o acordo (coluna escrita so pela aplicacao).
      const closed = await app.inject({
        method: 'PATCH', url: `/api/v1/agreements/${agreementId}`, headers: finance, payload: { closedAt: '2026-10-27T00:00:00Z' }
      });
      expect(closed.statusCode).toBe(200);
      expect(String((closed.json() as { closedAt: string }).closedAt)).toContain('2026-10-27');
      const reopened = await app.inject({
        method: 'PATCH', url: `/api/v1/agreements/${agreementId}`, headers: finance, payload: { closedAt: null }
      });
      expect(reopened.statusCode).toBe(200);
      expect(reopened.json()).toMatchObject({ closedAt: null });

      const audited = await pool.query<{ action: string }>(
        `SELECT action FROM audit_logs WHERE entity_id = ANY($1::uuid[])`,
        [[guardianId, contactId, agreementId]]
      );
      expect(audited.rows.map((row) => row.action)).toEqual(
        expect.arrayContaining(['agreement.updated', 'guardian.updated', 'student_contact.updated'])
      );
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

  /**
   * As rotas de migracao nao rodam staging/validacao/carga: elas leem e selam o que os scripts
   * Python deixaram em `migration_batches`, `migration_rows`, `migration_errors` e
   * `reconciliation_reports`. Por isso o seed abaixo insere essas linhas direto no banco.
   */
  describe('migracoes: registro, gate e triagem', () => {
    const authHeader = async (email: string) => ({ authorization: `Bearer ${await accessTokenOf(email)}` });
    const hashOf = (seed: string): string => createHash('sha256').update(seed).digest('hex');
    const registerPayload = (name = `VOA-${randomUUID().slice(0, 8)}.xlsx`) => ({
      sourceName: name,
      sourceHash: hashOf(name),
      sourceKind: 'xlsx' as const,
      rowCount: 12
    });

    const createBatch = async (): Promise<string> => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/migrations/batches',
        headers: await authHeader('admin@example.com'),
        payload: registerPayload()
      });
      expect(created.statusCode).toBe(201);
      return (created.json() as { id: string }).id;
    };

    const addRows = async (batchId: string, count: number, status = 'staged'): Promise<string[]> => {
      const ids: string[] = [];
      for (let index = 1; index <= count; index += 1) {
        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO migration_rows (batch_id, source_sheet, source_row_number, row_hash, payload, status)
           VALUES ($1, 'TBL_ESCOLA', $2, $3, '{}'::jsonb, $4) RETURNING id`,
          [batchId, index, hashOf(`${batchId}:${index}`), status]
        );
        ids.push(inserted.rows[0]?.id ?? '');
      }
      return ids;
    };

    const addFinding = async (
      batchId: string,
      severity: 'warning' | 'error' | 'blocking',
      options: { resolved?: boolean; rowId?: string | null } = {}
    ): Promise<string> => {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO migration_errors (batch_id, row_id, error_code, severity, field_name, message, details, resolved_at)
         VALUES ($1, $2, 'VALIDATOR_TEST', $3, 'ESCOLA_NOME', 'achado de teste', '{}'::jsonb, $4) RETURNING id`,
        [batchId, options.rowId ?? null, severity, options.resolved ? new Date() : null]
      );
      return inserted.rows[0]?.id ?? '';
    };

    const addReport = async (batchId: string, entityName = 'schools'): Promise<void> => {
      await pool.query(
        `INSERT INTO reconciliation_reports (batch_id, entity_name, source_count, staged_count, canonical_count)
         VALUES ($1, $2, 2, 2, 2)`,
        [batchId, entityName]
      );
    };

    it('registra a fonte uma unica vez e devolve o lote existente na repeticao', async () => {
      const headers = await authHeader('admin@example.com');
      const payload = registerPayload();

      const created = await app.inject({ method: 'POST', url: '/api/v1/migrations/batches', headers, payload });
      expect(created.statusCode).toBe(201);
      const batch = created.json() as { id: string; status: string; rowCount: number; duplicate: boolean; sourceKind: string };
      expect(batch).toMatchObject({ status: 'profiled', rowCount: 12, sourceKind: 'xlsx', duplicate: false });

      const repeated = await app.inject({ method: 'POST', url: '/api/v1/migrations/batches', headers, payload });
      expect(repeated.statusCode).toBe(200);
      expect(repeated.json()).toMatchObject({ id: batch.id, duplicate: true });

      const stored = await pool.query<{ total: number }>(
        'SELECT count(*)::int AS total FROM migration_batches WHERE source_name = $1', [payload.sourceName]);
      expect(stored.rows[0]?.total).toBe(1);

      const detail = await app.inject({ method: 'GET', url: `/api/v1/migrations/batches/${batch.id}`, headers });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        id: batch.id,
        rows: { total: 0, inError: 0 },
        findings: {},
        reconciliation: [],
        gate: { validate: { ok: false, blockers: ['NO_ROWS'] }, commit: { ok: false, blockers: ['NO_ROWS', 'NO_RECONCILIATION'] } }
      });
    });

    it('nega a escrita da migracao ao finance e ao viewer e libera a leitura', async () => {
      const payload = registerPayload();
      for (const email of ['finance@example.com', 'viewer@example.com']) {
        const refused = await app.inject({
          method: 'POST', url: '/api/v1/migrations/batches', headers: await authHeader(email), payload
        });
        expect({ email, statusCode: refused.statusCode }).toEqual({ email, statusCode: 403 });
        expect(refused.json()).toMatchObject({ code: 'FORBIDDEN' });
      }
      const batchId = await createBatch();
      const sealed = await app.inject({
        method: 'POST',
        url: `/api/v1/migrations/batches/${batchId}/validate`,
        headers: await authHeader('finance@example.com')
      });
      expect(sealed.statusCode).toBe(403);

      const listed = await app.inject({
        method: 'GET', url: '/api/v1/migrations/batches', headers: await authHeader('viewer@example.com')
      });
      expect(listed.statusCode).toBe(200);
      expect((listed.json() as { items: unknown[] }).items.length).toBeGreaterThan(0);
    });

    it('valida o lote limpo, sela o commit, audita as transicoes e nao reabre o lote', async () => {
      const headers = await authHeader('admin@example.com');
      const batchId = await createBatch();
      await addRows(batchId, 2);
      await addReport(batchId);

      const validated = await app.inject({
        method: 'POST', url: `/api/v1/migrations/batches/${batchId}/validate`, headers
      });
      expect(validated.statusCode).toBe(200);
      expect(validated.json()).toMatchObject({
        id: batchId,
        status: 'validated',
        counts: { rowsTotal: 2, rowsInError: 0, reconciliationReports: 1 },
        gate: { ok: true, blockers: [] }
      });

      const committed = await app.inject({
        method: 'POST', url: `/api/v1/migrations/batches/${batchId}/commit`, headers
      });
      expect(committed.statusCode).toBe(200);
      const sealed = committed.json() as { status: string; completedAt: string | null };
      expect(sealed.status).toBe('committed');
      expect(sealed.completedAt).not.toBeNull();

      const actions = await pool.query<{ action: string }>(
        `SELECT action FROM audit_logs
          WHERE entity_type = 'migration_batches' AND entity_id = $1 ORDER BY created_at`, [batchId]);
      expect(actions.rows.map((row) => row.action)).toEqual([
        'migration.batch.registered',
        'migration.batch.validated',
        'migration.batch.committed'
      ]);

      const again = await app.inject({
        method: 'POST', url: `/api/v1/migrations/batches/${batchId}/validate`, headers
      });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: 'INVALID_STATUS', status: 'committed' });

      const listed = await app.inject({
        method: 'GET', url: '/api/v1/migrations/batches?status=committed&limit=50', headers
      });
      expect(listed.statusCode).toBe(200);
      const items = (listed.json() as { items: { id: string; rows: number; openFindings: number }[] }).items;
      expect(items.find((item) => item.id === batchId)).toMatchObject({ rows: 2, openFindings: 0 });
    });
    it('bloqueia o gate com linha em erro e achado aberto e libera depois da triagem', async () => {
      const headers = await authHeader('admin@example.com');
      const batchId = await createBatch();
      const [, failingRowId] = await addRows(batchId, 2);
      await pool.query("UPDATE migration_rows SET status = 'error' WHERE id = $1", [failingRowId]);
      const blockingId = await addFinding(batchId, 'blocking', { rowId: failingRowId });

      const blocked = await app.inject({
        method: 'POST', url: `/api/v1/migrations/batches/${batchId}/validate`, headers
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toMatchObject({
        code: 'BATCH_NOT_READY',
        blockers: ['ROWS_IN_ERROR', 'OPEN_BLOCKING_FINDINGS'],
        counts: { rowsTotal: 2, rowsInError: 1, openFindings: { blocking: 1, error: 0 } }
      });

      const detail = await app.inject({ method: 'GET', url: `/api/v1/migrations/batches/${batchId}`, headers });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        rows: { total: 2, inError: 1, byStatus: { staged: 1, error: 1 } },
        findings: { blocking: { total: 1, open: 1 } },
        gate: { validate: { ok: false }, commit: { ok: false, blockers: ['ROWS_IN_ERROR', 'OPEN_BLOCKING_FINDINGS', 'NO_RECONCILIATION'] } }
      });

      const open = await app.inject({
        method: 'GET', url: `/api/v1/migrations/batches/${batchId}/errors?resolved=false`, headers
      });
      expect(open.statusCode).toBe(200);
      const opened = (open.json() as { items: Record<string, unknown>[] }).items;
      expect(opened).toMatchObject([
        { id: blockingId, errorCode: 'VALIDATOR_TEST', severity: 'blocking', fieldName: 'ESCOLA_NOME', sourceSheet: 'TBL_ESCOLA', sourceRowNumber: 2 }
      ]);
      expect(opened[0]).not.toHaveProperty('details');

      const resolved = await app.inject({
        method: 'POST',
        url: `/api/v1/migrations/errors/${blockingId}/resolve`,
        headers,
        payload: { note: 'nome conferido na aba TBL_ESCOLA' }
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json()).toMatchObject({ id: blockingId, duplicate: false });
      expect((resolved.json() as { resolvedAt: string | null }).resolvedAt).not.toBeNull();

      const repeated = await app.inject({
        method: 'POST', url: `/api/v1/migrations/errors/${blockingId}/resolve`, headers
      });
      expect(repeated.statusCode).toBe(200);
      expect(repeated.json()).toMatchObject({ id: blockingId, duplicate: true });

      // Resolver o achado nao reescreve a linha do staging: a marca `error` continua bloqueando.
      const stillBlocked = await app.inject({
        method: 'POST', url: `/api/v1/migrations/batches/${batchId}/validate`, headers
      });
      expect(stillBlocked.statusCode).toBe(409);
      expect(stillBlocked.json()).toMatchObject({ blockers: ['ROWS_IN_ERROR'] });

      await pool.query("UPDATE migration_rows SET status = 'staged' WHERE id = $1", [failingRowId]);
      const unblocked = await app.inject({
        method: 'POST', url: `/api/v1/migrations/batches/${batchId}/validate`, headers
      });
      expect(unblocked.statusCode).toBe(200);
      expect(unblocked.json()).toMatchObject({ status: 'validated' });
    });
    it('nao bloqueia por achado de aviso e exige reconciliacao para o commit', async () => {
      const headers = await authHeader('admin@example.com');
      const batchId = await createBatch();
      await addRows(batchId, 1);
      await addFinding(batchId, 'warning');

      const validated = await app.inject({
        method: 'POST', url: `/api/v1/migrations/batches/${batchId}/validate`, headers
      });
      expect(validated.statusCode).toBe(200);
      expect(validated.json()).toMatchObject({ status: 'validated', gate: { ok: true, blockers: [] } });

      const refused = await app.inject({
        method: 'POST', url: `/api/v1/migrations/batches/${batchId}/commit`, headers
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'BATCH_NOT_READY', blockers: ['NO_RECONCILIATION'] });

      await addReport(batchId);
      const committed = await app.inject({
        method: 'POST', url: `/api/v1/migrations/batches/${batchId}/commit`, headers
      });
      expect(committed.statusCode).toBe(200);
      expect(committed.json()).toMatchObject({ status: 'committed', gate: { ok: true, blockers: [] } });

      const detail = await app.inject({ method: 'GET', url: `/api/v1/migrations/batches/${batchId}`, headers });
      expect(detail.json()).toMatchObject({
        findings: { warning: { total: 1, open: 1 } },
        reconciliation: [{ entityName: 'schools', sourceCount: 2, canonicalCount: 2 }]
      });
    });

    it('responde 400 e 404 nos identificadores e filtros invalidos', async () => {
      const headers = await authHeader('admin@example.com');
      const badHash = await app.inject({
        method: 'POST',
        url: '/api/v1/migrations/batches',
        headers,
        payload: { sourceName: 'VOA.xlsx', sourceHash: 'nao-e-sha256' }
      });
      expect(badHash.statusCode).toBe(400);
      expect(badHash.json()).toMatchObject({ code: 'INVALID_REQUEST' });

      const invalidStatus = await app.inject({
        method: 'GET', url: '/api/v1/migrations/batches?status=aprovado', headers
      });
      expect(invalidStatus.statusCode).toBe(400);

      const batchId = randomUUID();
      for (const [url, method] of [
        [`/api/v1/migrations/batches/${batchId}`, 'GET'],
        [`/api/v1/migrations/batches/${batchId}/errors`, 'GET'],
        [`/api/v1/migrations/batches/${batchId}/validate`, 'POST'],
        [`/api/v1/migrations/batches/${batchId}/commit`, 'POST']
      ] as const) {
        const missing = await app.inject({ method, url, headers });
        expect({ url, statusCode: missing.statusCode }).toEqual({ url, statusCode: 404 });
      }

      const missingFinding = await app.inject({
        method: 'POST', url: `/api/v1/migrations/errors/${randomUUID()}/resolve`, headers
      });
      expect(missingFinding.statusCode).toBe(404);
      expect(missingFinding.json()).toMatchObject({ code: 'NOT_FOUND' });

      const invalidId = await app.inject({
        method: 'GET', url: '/api/v1/migrations/batches/nao-e-uuid', headers
      });
      expect(invalidId.statusCode).toBe(400);
    });
  });
});
