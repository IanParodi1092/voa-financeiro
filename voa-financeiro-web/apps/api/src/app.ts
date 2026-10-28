import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.js';
import type { RouteDeps, Waker } from './http/deps.js';
import { createPatchRunner } from './http/patch-runner.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerFinanceRoutes } from './routes/finance.js';
import { registerIdentityRoutes } from './routes/identity.js';
import { registerMigrationRoutes } from './routes/migration.js';
import { registerOpsRoutes } from './routes/ops.js';
import { registerReconciliationRoutes } from './routes/reconciliation.js';

/**
 * Monta a instancia do Fastify: plugins de plataforma, as dependencias do processo e os modulos de
 * rota, um por contexto de negocio.
 *
 * O processo continua sendo um so (monolito modular). A divisao e por contexto, nao por deploy:
 * `catalog`, `finance`, `migration`, `reconciliation`, `identity` e `ops` compartilham o mesmo pool
 * e as mesmas transacoes - e isso que mantem a cadeia financeira (`agreements` -> `installments` ->
 * `payments` -> `retention_ledger`) consistente. Separar o arquivo por contexto custa uma linha por
 * modulo e deixa cada rota perto das vizinhas que compartilham invariantes.
 */
export interface BuildAppOptions {
  /** `wake()` da fila de saida; `server.ts` preenche depois de subir o worker. */
  outbox?: Waker;
  /** `wake()` do consumidor de `asaas_events`; o webhook chama depois do `INSERT`. */
  asaasEvents?: Waker;
}

export function buildApp(config: AppConfig, pool?: Pool, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, genReqId: () => randomUUID() });
  app.register(helmet);
  app.register(cors, { origin: config.corsOrigins, credentials: true });
  app.register(rateLimit, { max: config.RATE_LIMIT_MAX, timeWindow: '1 minute' });
  app.register(jwt, { secret: config.AUTH_JWT_SECRET, sign: { expiresIn: '15m' } });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
  });

  const deps: RouteDeps = {
    pool,
    config,
    patchRunner: createPatchRunner(pool),
    ...(options.outbox === undefined ? {} : { outbox: options.outbox }),
    ...(options.asaasEvents === undefined ? {} : { asaasEvents: options.asaasEvents })
  };
  registerOpsRoutes(app, deps);
  registerCatalogRoutes(app, deps);
  registerFinanceRoutes(app, deps);
  registerMigrationRoutes(app, deps);
  registerReconciliationRoutes(app, deps);
  registerIdentityRoutes(app, deps);

  app.setNotFoundHandler((request, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: 'Route not found', correlationId: request.id }));
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    return reply.code(statusCode >= 400 ? statusCode : 500).send({ code: 'INTERNAL_ERROR', message: 'Unexpected error', correlationId: request.id });
  });
  return app;
}
