import 'dotenv/config';
import { applyMigrations } from './run-migrations.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../config.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DIRECT_DATABASE_URL ?? config.DATABASE_URL });
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

try {
  const { applied, skipped } = await applyMigrations(pool, migrationsDirectory);
  for (const file of applied) console.log(`Applied migration ${file}`);
  console.log(`Migrations: ${applied.length} aplicadas, ${skipped.length} ja aplicadas.`);
} finally {
  await pool.end();
}