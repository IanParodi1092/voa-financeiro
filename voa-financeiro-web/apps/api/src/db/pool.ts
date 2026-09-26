import pg from 'pg';
import type { AppConfig } from '../config.js';

export function createPool(config: AppConfig): pg.Pool {
  return new pg.Pool({ connectionString: config.DATABASE_URL, max: 10, application_name: 'voa-financeiro-api' });
}