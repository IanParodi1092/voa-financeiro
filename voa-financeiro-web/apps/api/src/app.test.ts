import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const app = buildApp(loadConfig({
  DATABASE_URL: 'postgresql://localhost/test',
  AUTH_JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long'
}));
const authHeaders = () => ({ authorization: `Bearer ${app.jwt.sign({ sub: 'user-1', roles: ['admin'] })}` });

describe('health endpoints', () => {
  it('returns live status without a database', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('rejects unauthenticated identity requests', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('returns the signed identity payload', async () => {
    const token = app.jwt.sign({ sub: 'user-1', roles: ['admin'] });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token}` }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { sub: 'user-1', roles: ['admin'] } });
  });

  it('validates customer input before requiring the database', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/customers', headers: authHeaders(), payload: { fullName: '' } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('reports unavailable database for catalog reads', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/customers', headers: authHeaders() });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
  });

  it('rejects Asaas webhooks without the configured token', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/webhooks/asaas', payload: { id: 'event-1' } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('guardioes e contatos do aluno', () => {
  const studentId = '8a1f5b64-7d3e-4f5a-9b0e-3f6f2d1c4a70';
  const rowId = '0c2b7a91-5e4d-4c8b-9a3f-2b1d6e8f0c11';

  it('lista guardioes e contatos do aluno somente com banco disponivel', async () => {
    for (const path of ['guardians', 'contacts']) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/students/${studentId}/${path}`, headers: authHeaders() });
      expect({ path, status: response.statusCode }).toEqual({ path, status: 503 });
      expect(response.json()).toMatchObject({ code: 'DATABASE_UNAVAILABLE' });
    }
  });

  it('recusa id de aluno malformado antes de tocar o banco', async () => {
    for (const path of ['guardians', 'contacts']) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/students/nao-e-uuid/${path}`, headers: authHeaders() });
      expect({ path, status: response.statusCode }).toEqual({ path, status: 400 });
    }
  });

  it('valida o corpo do PATCH do guardiao antes de exigir o banco', async () => {
    const accepted = await app.inject({
      method: 'PATCH',
      url: `/api/v1/guardians/${rowId}`,
      headers: authHeaders(),
      payload: { customerId: null, isVerified: true, maritalStatus: 'Casada' }
    });
    expect(accepted.statusCode).toBe(503);

    const rejected = await app.inject({
      method: 'PATCH',
      url: `/api/v1/guardians/${rowId}`,
      headers: authHeaders(),
      payload: { customerId: 'nao-e-uuid' }
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('recusa rotulo de status do contato do aluno fora do canonico', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/student-contacts/${rowId}`,
      headers: authHeaders(),
      payload: { status: 'desativado' }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

afterAll(async () => app.close());