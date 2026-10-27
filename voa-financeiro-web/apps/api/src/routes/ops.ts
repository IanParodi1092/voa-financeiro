import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from '../http/deps.js';

/**
 * Rotas de infraestrutura: saude do processo e o receptor de webhook do Asaas.
 *
 * Nao tocam regra de negocio. O webhook so grava o evento cru em `asaas_events` e responde 202: o
 * processamento (criar cobranca, sincronizar status) e outro passo, que ainda nao existe.
 */
export function registerOpsRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { pool, config } = deps;

  app.get('/health/live', async () => ({ status: 'ok', service: 'voa-financeiro-api' }));
  app.get('/health/ready', async (_request, reply) => {
    if (!pool) return { status: 'ok', database: 'not-configured' };
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', database: 'up' };
    } catch {
      return reply.code(503).send({ status: 'degraded', database: 'down' });
    }
  });

  app.get('/api/v1', async () => ({ name: 'VOA Financeiro API', version: 'v1' }));
  app.post('/api/v1/webhooks/asaas', async (request, reply) => {
    const providedToken = request.headers['asaas-access-token'];
    if (!config.ASAAS_WEBHOOK_TOKEN || typeof providedToken !== 'string' || providedToken !== config.ASAAS_WEBHOOK_TOKEN) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Invalid webhook credentials', correlationId: request.id });
    }
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const payload = request.body as Record<string, unknown>;
    const eventId = typeof payload.id === 'string' ? payload.id : request.id;
    const eventType = typeof payload.event === 'string' ? payload.event : 'unknown';
    const externalChargeId = typeof payload.payment === 'object' && payload.payment !== null && 'id' in payload.payment && typeof payload.payment.id === 'string'
      ? payload.payment.id : null;
    const result = await pool.query(`INSERT INTO asaas_events (external_event_id, environment, event_type, external_charge_id, payload)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (external_event_id) DO NOTHING
      RETURNING id`, [eventId, config.ASAAS_ENVIRONMENT, eventType, externalChargeId, payload]);
    return reply.code(202).send({ accepted: true, duplicate: result.rowCount === 0 });
  });
}
