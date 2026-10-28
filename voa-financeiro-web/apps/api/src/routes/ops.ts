import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { asaasEventsSummary, retryFailedAsaasEvent } from '../db/asaas-events.js';
import { outboxSummary, retryDeadMessage } from '../db/outbox.js';
import type { RouteDeps } from '../http/deps.js';
import { actorIdOf, requireAuthentication, requirePermission } from '../http/guards.js';

/**
 * Rotas de infraestrutura: saude do processo, o receptor de webhook do Asaas e a operacao da fila
 * de saida.
 *
 * Nao tocam regra de negocio. O webhook so grava o evento cru em `asaas_events` e responde 202; os
 * endpoints de `ops` leem o estado das duas filas (saida e entrada) e reabrem uma linha morta, nada
 * mais. Aplicar o evento e trabalho do laco em `outbox/events.ts`.
 */

const idParamSchema = z.string().uuid();

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
    // Evento novo acorda o consumidor agora; o poll pegaria de qualquer forma, so que ate 2s depois.
    if (result.rowCount !== 0) deps.asaasEvents?.wake();
    return reply.code(202).send({ accepted: true, duplicate: result.rowCount === 0 });
  });

  /**
   * Estado da fila. `counts` sozinho nao diferencia "acabou de chegar" de "esta preso ha 20 minutos",
   * e por isso o resumo traz `oldestPendingAgeSeconds` - fila com pendente velho significa worker
   * parado ou provedor recusando tudo.
   */
  app.get('/api/v1/ops/outbox', { preHandler: requireAuthentication }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    return outboxSummary(pool, { deadLimit: 10 });
  });

  /**
   * Reabre uma linha `dead`: `attempts = 0`, `available_at = now()`. So `dead` entra - em `pending` e
   * `processing` o 409 evita criar uma segunda entrega concorrente para a mesma mensagem.
   *
   * Nao acorda o worker: o poll seguinte (2s por default) ja a pega, e o endpoint continua sem
   * depender do laco estar na mesma instancia.
   */
  app.post('/api/v1/ops/outbox/:id/retry', { preHandler: requirePermission('audit') }, async (request, reply) => {
    const parsedId = idParamSchema.safeParse((request.params as { id?: string }).id);
    if (!parsedId.success) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid outbox id', correlationId: request.id });
    }
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const outcome = await retryDeadMessage(pool, parsedId.data);
    if (outcome.status === 'not_found') {
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'Outbox event not found', correlationId: request.id });
    }
    if (outcome.status === 'not_dead') {
      return reply.code(409).send({
        code: 'OUTBOX_NOT_DEAD',
        message: `Outbox event is ${outcome.currentStatus}`,
        correlationId: request.id
      });
    }
    await recordAudit(pool, request.log, request.id, {
      action: 'outbox.retried',
      actorId: actorIdOf(request),
      entityType: 'outbox_events',
      entityId: parsedId.data,
      metadata: {
        dedupeKey: outcome.dedupeKey,
        previousError: outcome.previousError,
        ownerEntityType: outcome.entityType,
        ownerEntityId: outcome.entityId
      }
    });
    return { id: parsedId.data, status: 'pending', attempts: 0, dedupeKey: outcome.dedupeKey };
  });

  /**
   * Fila de entrada. Mesmo raciocinio do `/ops/outbox`, mas o alarme pesa mais: o provedor descarta o
   * evento depois de 14 dias e pausa a entrega depois de 15 falhas consecutivas, entao
   * `oldestPendingAgeSeconds` alto aqui e evento que vai deixar de existir do outro lado.
   */
  app.get('/api/v1/ops/asaas-events', { preHandler: requireAuthentication }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    return asaasEventsSummary(pool, { failedLimit: 10 });
  });

  /**
   * Reabre um evento `failed_at`: `attempts = 0` e `failed_at = NULL`. So evento morto entra - em
   * `pending` ou processado o 409 (`ASAAS_EVENT_NOT_FAILED`) evita aplicar o mesmo evento duas vezes
   * em paralelo com o laco.
   */
  app.post('/api/v1/ops/asaas-events/:id/retry', { preHandler: requirePermission('audit') }, async (request, reply) => {
    const parsedId = idParamSchema.safeParse((request.params as { id?: string }).id);
    if (!parsedId.success) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid asaas event id', correlationId: request.id });
    }
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const outcome = await retryFailedAsaasEvent(pool, parsedId.data);
    if (outcome.status === 'not_found') {
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'Asaas event not found', correlationId: request.id });
    }
    if (outcome.status === 'not_failed') {
      return reply.code(409).send({
        code: 'ASAAS_EVENT_NOT_FAILED',
        message: `Asaas event is ${outcome.currentStatus}`,
        correlationId: request.id
      });
    }
    await recordAudit(pool, request.log, request.id, {
      action: 'asaas_event.retried',
      actorId: actorIdOf(request),
      entityType: 'asaas_events',
      entityId: parsedId.data,
      metadata: {
        externalEventId: outcome.externalEventId,
        eventType: outcome.eventType,
        previousError: outcome.previousError
      }
    });
    return {
      id: parsedId.data,
      status: 'pending',
      attempts: 0,
      externalEventId: outcome.externalEventId,
      eventType: outcome.eventType
    };
  });
}
