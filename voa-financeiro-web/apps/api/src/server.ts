import 'dotenv/config';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';

const config = loadConfig();
const pool = createPool(config);
const app = buildApp(config, pool);

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  await pool.end();
  process.exit(1);
}

const close = async () => { await app.close(); await pool.end(); };
process.on('SIGINT', close);
process.on('SIGTERM', close);