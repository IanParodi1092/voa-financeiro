import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { applyMigrations } from './db/run-migrations.js';
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
});
