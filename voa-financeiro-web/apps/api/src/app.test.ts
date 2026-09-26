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

afterAll(async () => app.close());