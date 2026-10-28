import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

/** `COOKIE_SECURE=true` (also accepts `1`, `yes`, `on`); anything else means a plain cookie. */
const booleanish = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return defaultValue;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
  }, z.boolean());

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1),
  DIRECT_DATABASE_URL: z.string().min(1).optional(),
  AUTH_JWT_SECRET: z.string().min(32),
  AUTH_REFRESH_SECRET: z.string().min(32).optional(),
  COOKIE_DOMAIN: z.preprocess((value) => (value === '' ? undefined : value), z.string().min(1).optional()),
  COOKIE_SECURE: booleanish(false),
  ASAAS_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  ASAAS_WEBHOOK_TOKEN: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  MIGRATION_SOURCE_DIR: z.string().default('../../_import'),
  MIGRATION_BATCH_SIZE: z.coerce.number().int().positive().default(500),
  WEBHOOK_RETRY_LIMIT: z.coerce.number().int().nonnegative().default(5),
  ASAAS_API_URL: z.string().url().default('https://api-sandbox.asaas.com/v3'),
  ASAAS_API_KEY: z.preprocess((value) => value === '' ? undefined : value, z.string().min(1).optional()),
  OUTBOX_WORKER_ENABLED: booleanish(true),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(50).default(5),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  OUTBOX_LEASE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  /** Dias de historico de `done` na fila; `0` desliga o expurgo (`docs/OUTBOX_DESIGN.md` secao 15). */
  OUTBOX_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(90),
  /** Consumidor de `asaas_events` (`docs/ASAAS_EVENT_RULES.md`). */
  ASAAS_EVENTS_WORKER_ENABLED: booleanish(true),
  ASAAS_EVENT_BATCH_SIZE: z.coerce.number().int().positive().max(50).default(10),
  /** Lease do evento: `last_attempt_at` mais velho que isto pode ser pego de novo. */
  ASAAS_EVENT_LEASE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000)
});

export interface RefreshCookieConfig {
  name: string;
  secure: boolean;
  domain?: string | undefined;
}

export type AppConfig = z.infer<typeof environmentSchema> & {
  corsOrigins: string[];
  /** Keyed hash of the refresh token; falls back to `AUTH_JWT_SECRET` when not configured. */
  refreshSecret: string;
  refreshCookie: RefreshCookieConfig;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = environmentSchema.parse(env);
  return {
    ...parsed,
    corsOrigins: parsed.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    refreshSecret: parsed.AUTH_REFRESH_SECRET ?? parsed.AUTH_JWT_SECRET,
    refreshCookie: { name: 'voa_refresh', secure: parsed.COOKIE_SECURE, domain: parsed.COOKIE_DOMAIN }
  };
}