import 'dotenv/config';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createAsaasClient } from './integrations/asaas-client.js';
import { startOutboxWorker } from './outbox/worker.js';

/**
 * Ponto de entrada do processo.
 *
 * O worker da fila sobe **aqui**, e nao em `buildApp`: o teste de integracao monta a app com
 * `app.inject` e derruba o schema temporario no `afterAll`, entao um laco nascido em `buildApp`
 * continuaria consultando um schema que nao existe mais.
 */

const config = loadConfig();
const pool = createPool(config);
const app = buildApp(config, pool);

const asaas = config.ASAAS_API_KEY
  ? createAsaasClient({ baseUrl: config.ASAAS_API_URL, apiKey: config.ASAAS_API_KEY })
  : undefined;

const outbox = startOutboxWorker({
  pool,
  logger: app.log,
  enabled: config.OUTBOX_WORKER_ENABLED,
  asaas,
  settings: {
    environment: config.ASAAS_ENVIRONMENT,
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    batchSize: config.OUTBOX_BATCH_SIZE,
    leaseTimeoutMs: config.OUTBOX_LEASE_TIMEOUT_MS
  }
});

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  await outbox.stop({ timeoutMs: 0 });
  await pool.end();
  process.exit(1);
}

/**
 * Ordem de encerramento: parar o worker, esperar o ciclo em andamento, `app.close()`, `pool.end()`.
 *
 * `pool.end()` com um ciclo em voo produz `Cannot use a pool after calling end on the pool`, e no
 * Node 22 uma promise rejeitada sem `catch` derruba o processo. O `closing` evita que um segundo
 * `SIGINT` repita a sequencia com o pool ja fechado.
 */
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await outbox.stop({ timeoutMs: 10_000 });
  await app.close();
  await pool.end();
};
process.on('SIGINT', close);
process.on('SIGTERM', close);