import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  DIRECT_DATABASE_URL: z.string().min(1).optional(),
  AUTH_JWT_SECRET: z.string().min(32),
  ASAAS_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  ASAAS_WEBHOOK_TOKEN: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  MIGRATION_SOURCE_DIR: z.string().default('../../_import'),
  MIGRATION_BATCH_SIZE: z.coerce.number().int().positive().default(500),
  WEBHOOK_RETRY_LIMIT: z.coerce.number().int().nonnegative().default(5)
});

export type AppConfig = z.infer<typeof environmentSchema> & { corsOrigins: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(env);
  return { ...parsed, corsOrigins: parsed.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean) };
}