import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import { verifyPassword } from './auth/password.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  createRefreshToken,
  createSessionTokenId,
  hashRefreshToken
} from './auth/tokens.js';
import { clearRefreshCookie, readCookie, serializeRefreshCookie } from './auth/cookies.js';
import { hasPermission, type Permission } from './auth/roles.js';
import { recordAudit } from './audit.js';

const loginSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase()),
  password: z.string().min(1)
});

const customerSchema = z.object({
  fullName: z.string().trim().min(2).max(200),
  documentNumber: z.string().trim().max(30).optional(),
  email: z.string().email().transform((value) => value.toLowerCase()).optional(),
  phone: z.string().trim().max(30).optional()
});

const schoolSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  tradeName: z.string().trim().max(200).optional(),
  documentNumber: z.string().trim().max(30).optional()
});

const contactSchema = z.object({
  customerId: z.string().uuid(),
  type: z.enum(['email', 'phone', 'whatsapp', 'other']),
  value: z.string().trim().min(1).max(200),
  isPrimary: z.boolean().default(false)
});

const studentSchema = z.object({
  schoolId: z.string().uuid(),
  customerId: z.string().uuid().optional(),
  fullName: z.string().trim().min(2).max(200),
  documentNumber: z.string().trim().max(30).optional(),
  enrollmentNumber: z.string().trim().max(50).optional()
});

const agreementSchema = z.object({
  schoolId: z.string().uuid(),
  customerId: z.string().uuid(),
  studentId: z.string().uuid().optional(),
  reference: z.string().trim().max(200).optional(),
  totalAmount: z.number().nonnegative(),
  installmentsCount: z.number().int().positive().max(120)
});

const installmentSchema = z.object({
  agreementId: z.string().uuid(),
  installmentNumber: z.number().int().positive(),
  dueDate: z.string().date(),
  originalAmount: z.number().nonnegative()
});

const paymentSchema = z.object({
  installmentId: z.string().uuid(),
  amount: z.number().positive(),
  paidAt: z.string().datetime().optional(),
  source: z.enum(['manual', 'asaas', 'bank_transfer', 'other']).default('manual'),
  externalId: z.string().trim().max(200).optional()
});

function sendUnauthorized(request: FastifyRequest, reply: FastifyReply): void {
  reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Authentication required', correlationId: request.id });
}

function sendForbidden(request: FastifyRequest, reply: FastifyReply, permission: Permission): void {
  reply.code(403).send({
    code: 'FORBIDDEN',
    message: `Role lacks the ${permission} permission`,
    correlationId: request.id
  });
}

/** Claims of the verified access token, or `null` when the request was already answered with 401. */
async function verifiedClaims(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    sendUnauthorized(request, reply);
    return null;
  }
  const claims = request.user as { sub?: string; sid?: string; name?: string; roles?: string[] };
  return {
    sub: String(claims.sub ?? ''),
    sid: claims.sid,
    name: claims.name,
    roles: Array.isArray(claims.roles) ? claims.roles : []
  };
}

/** Builds the preHandler that authenticates the request and requires `permission`. */
function requirePermission(permission: Permission) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const claims = await verifiedClaims(request, reply);
    if (!claims) return;
    if (!hasPermission(claims.roles, permission)) sendForbidden(request, reply, permission);
  };
}

/**
 * Authenticates the request and requires the `read` permission (every role has it).
 * Domain writes declare `requirePermission('catalog:write')` or `requirePermission('finance:write')`.
 */
const requireAuthentication = requirePermission('read');

/** preHandler for the auth routes: a valid access token is enough (no role required). */
const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  await verifiedClaims(request, reply);
};

/** Id of the authenticated user, for the audit trail. */
function actorIdOf(request: FastifyRequest): string | null {
  const claims = request.user as { sub?: string } | undefined;
  return claims?.sub ?? null;
}

export function buildApp(config: AppConfig, pool?: Pool): FastifyInstance {
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, genReqId: () => randomUUID() });
  app.register(helmet);
  app.register(cors, { origin: config.corsOrigins, credentials: true });
  app.register(rateLimit, { max: config.RATE_LIMIT_MAX, timeWindow: '1 minute' });
  app.register(jwt, { secret: config.AUTH_JWT_SECRET, sign: { expiresIn: '15m' } });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
  });

  type Queryable = Pool | PoolClient;

  /**
   * Creates one `auth_sessions` row and the short access token that points at it.
   *
   * `expires_at` is the session window (the refresh token lifetime) and not the `exp` of the access
   * token: the access token is short by its own `exp`, and the refresh token is what keeps the
   * session alive. Only the HMAC-SHA256 of the refresh token is persisted.
   */
  const issueSession = async (
    executor: Queryable,
    userId: string,
    displayName: string,
    roles: string[],
    userAgent: string | undefined
  ) => {
    const tokenId = createSessionTokenId();
    const refreshToken = createRefreshToken();
    await executor.query(
      `INSERT INTO auth_sessions (user_id, token_id, refresh_token_hash, refresh_expires_at, expires_at, user_agent)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4::int), now() + make_interval(secs => $4::int), $5)`,
      [userId, tokenId, hashRefreshToken(refreshToken, config.refreshSecret), REFRESH_TOKEN_TTL_SECONDS, userAgent ?? null]
    );
    const accessToken = app.jwt.sign({ sub: userId, sid: tokenId, name: displayName, roles });
    return { tokenId, refreshToken, accessToken };
  };

  const setRefreshCookie = (reply: FastifyReply, refreshToken: string): void => {
    reply.header('set-cookie', serializeRefreshCookie(config.refreshCookie, refreshToken, REFRESH_TOKEN_TTL_SECONDS));
  };

  const clearRefresh = (reply: FastifyReply): void => {
    reply.header('set-cookie', clearRefreshCookie(config.refreshCookie));
  };

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

  app.get('/api/v1/customers', { preHandler: requireAuthentication }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const query = request.query as { search?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 100);
    const search = query.search?.trim() ?? '';
    const result = await pool.query(`SELECT id, full_name AS "fullName", document_number AS "documentNumber", email, phone, status, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM customers WHERE deleted_at IS NULL AND ($1 = '' OR full_name ILIKE $2 OR document_number ILIKE $2 OR email ILIKE $2)
      ORDER BY full_name LIMIT $3`, [search, `%${search}%`, limit]);
    return { items: result.rows, limit, search };
  });

  app.post('/api/v1/customers', { preHandler: requirePermission('catalog:write') }, async (request, reply) => {
    const parsed = customerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid customer data', correlationId: request.id });
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const { fullName, documentNumber, email, phone } = parsed.data;
    const result = await pool.query(`INSERT INTO customers (full_name, document_number, email, phone)
      VALUES ($1, $2, $3, $4)
      RETURNING id, full_name AS "fullName", document_number AS "documentNumber", email, phone, status, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [fullName, documentNumber ?? null, email ?? null, phone ?? null]);
    await recordAudit(pool, request.log, request.id, {
      action: 'customer.created',
      actorId: actorIdOf(request),
      entityType: 'customers',
      entityId: String(result.rows[0]?.id ?? '')
    });
    return reply.code(201).send(result.rows[0]);
  });

  app.get('/api/v1/schools', { preHandler: requireAuthentication }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const query = request.query as { search?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 100);
    const search = query.search?.trim() ?? '';
    const result = await pool.query(`SELECT id, legal_name AS "legalName", trade_name AS "tradeName", document_number AS "documentNumber", status, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM schools WHERE deleted_at IS NULL AND ($1 = '' OR legal_name ILIKE $2 OR trade_name ILIKE $2 OR document_number ILIKE $2)
      ORDER BY legal_name LIMIT $3`, [search, `%${search}%`, limit]);
    return { items: result.rows, limit, search };
  });

  app.post('/api/v1/schools', { preHandler: requirePermission('catalog:write') }, async (request, reply) => {
    const parsed = schoolSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid school data', correlationId: request.id });
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const { legalName, tradeName, documentNumber } = parsed.data;
    const result = await pool.query(`INSERT INTO schools (legal_name, trade_name, document_number)
      VALUES ($1, $2, $3)
      RETURNING id, legal_name AS "legalName", trade_name AS "tradeName", document_number AS "documentNumber", status, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [legalName, tradeName ?? null, documentNumber ?? null]);
    await recordAudit(pool, request.log, request.id, {
      action: 'school.created',
      actorId: actorIdOf(request),
      entityType: 'schools',
      entityId: String(result.rows[0]?.id ?? '')
    });
    return reply.code(201).send(result.rows[0]);
  });

  app.get('/api/v1/students', { preHandler: requireAuthentication }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const query = request.query as { schoolId?: string; search?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 100);
    const search = query.search?.trim() ?? '';
    const result = await pool.query(`SELECT id, school_id AS "schoolId", customer_id AS "customerId", full_name AS "fullName", document_number AS "documentNumber", enrollment_number AS "enrollmentNumber", status, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM students WHERE deleted_at IS NULL AND ($1 = '' OR full_name ILIKE $2 OR document_number ILIKE $2 OR enrollment_number ILIKE $2)
      AND ($3::uuid IS NULL OR school_id = $3::uuid) ORDER BY full_name LIMIT $4`, [search, `%${search}%`, query.schoolId ?? null, limit]);
    return { items: result.rows, limit, search, schoolId: query.schoolId ?? null };
  });

  app.post('/api/v1/students', { preHandler: requirePermission('catalog:write') }, async (request, reply) => {
    const parsed = studentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid student data', correlationId: request.id });
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const { schoolId, customerId, fullName, documentNumber, enrollmentNumber } = parsed.data;
    const result = await pool.query(`INSERT INTO students (school_id, customer_id, full_name, document_number, enrollment_number)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, school_id AS "schoolId", customer_id AS "customerId", full_name AS "fullName", document_number AS "documentNumber", enrollment_number AS "enrollmentNumber", status, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [schoolId, customerId ?? null, fullName, documentNumber ?? null, enrollmentNumber ?? null]);
    await recordAudit(pool, request.log, request.id, {
      action: 'student.created',
      actorId: actorIdOf(request),
      entityType: 'students',
      entityId: String(result.rows[0]?.id ?? '')
    });
    return reply.code(201).send(result.rows[0]);
  });

  app.get('/api/v1/customers/:customerId/contacts', { preHandler: requireAuthentication }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const { customerId } = request.params as { customerId: string };
    if (!z.string().uuid().safeParse(customerId).success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid customer id', correlationId: request.id });
    const result = await pool.query(`SELECT id, customer_id AS "customerId", type, value, is_primary AS "isPrimary", is_verified AS "isVerified", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM contacts WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC, created_at`, [customerId]);
    return { items: result.rows };
  });

  app.post('/api/v1/customers/:customerId/contacts', { preHandler: requirePermission('catalog:write') }, async (request, reply) => {
    const { customerId } = request.params as { customerId: string };
    const parsed = contactSchema.safeParse({ ...(request.body as object), customerId });
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid contact data', correlationId: request.id });
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const { type, value, isPrimary } = parsed.data;
    const result = await pool.query(`INSERT INTO contacts (customer_id, type, value, is_primary)
      VALUES ($1, $2, $3, $4)
      RETURNING id, customer_id AS "customerId", type, value, is_primary AS "isPrimary", is_verified AS "isVerified", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [customerId, type, value, isPrimary]);
    await recordAudit(pool, request.log, request.id, {
      action: 'contact.created',
      actorId: actorIdOf(request),
      entityType: 'contacts',
      entityId: String(result.rows[0]?.id ?? '')
    });
    return reply.code(201).send(result.rows[0]);
  });

  app.get('/api/v1/agreements', { preHandler: requireAuthentication }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const query = request.query as { customerId?: string; schoolId?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 100);
    const result = await pool.query(`SELECT id, school_id AS "schoolId", customer_id AS "customerId", student_id AS "studentId", reference, total_amount AS "totalAmount", installments_count AS "installmentsCount", status, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM agreements WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR customer_id = $1::uuid) AND ($2::uuid IS NULL OR school_id = $2::uuid)
      ORDER BY created_at DESC LIMIT $3`, [query.customerId ?? null, query.schoolId ?? null, limit]);
    return { items: result.rows, limit };
  });

  app.post('/api/v1/agreements', { preHandler: requirePermission('finance:write') }, async (request, reply) => {
    const parsed = agreementSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid agreement data', correlationId: request.id });
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const { schoolId, customerId, studentId, reference, totalAmount, installmentsCount } = parsed.data;
    const result = await pool.query(`INSERT INTO agreements (school_id, customer_id, student_id, reference, total_amount, installments_count)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, school_id AS "schoolId", customer_id AS "customerId", student_id AS "studentId", reference, total_amount AS "totalAmount", installments_count AS "installmentsCount", status, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [schoolId, customerId, studentId ?? null, reference ?? null, totalAmount, installmentsCount]);
    await recordAudit(pool, request.log, request.id, {
      action: 'agreement.created',
      actorId: actorIdOf(request),
      entityType: 'agreements',
      entityId: String(result.rows[0]?.id ?? '')
    });
    return reply.code(201).send(result.rows[0]);
  });

  app.get('/api/v1/installments', { preHandler: requireAuthentication }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const query = request.query as { agreementId?: string; status?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 200);
    const result = await pool.query(`SELECT id, agreement_id AS "agreementId", installment_number AS "installmentNumber", due_date AS "dueDate", original_amount AS "originalAmount", status, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM installments WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR agreement_id = $1::uuid) AND ($2 = '' OR status = $2)
      ORDER BY due_date, installment_number LIMIT $3`, [query.agreementId ?? null, query.status ?? '', limit]);
    return { items: result.rows, limit };
  });

  app.post('/api/v1/installments', { preHandler: requirePermission('finance:write') }, async (request, reply) => {
    const parsed = installmentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid installment data', correlationId: request.id });
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const { agreementId, installmentNumber, dueDate, originalAmount } = parsed.data;
    const result = await pool.query(`INSERT INTO installments (agreement_id, installment_number, due_date, original_amount)
      VALUES ($1, $2, $3, $4)
      RETURNING id, agreement_id AS "agreementId", installment_number AS "installmentNumber", due_date AS "dueDate", original_amount AS "originalAmount", status, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [agreementId, installmentNumber, dueDate, originalAmount]);
    await recordAudit(pool, request.log, request.id, {
      action: 'installment.created',
      actorId: actorIdOf(request),
      entityType: 'installments',
      entityId: String(result.rows[0]?.id ?? '')
    });
    return reply.code(201).send(result.rows[0]);
  });

  app.get('/api/v1/payments', { preHandler: requireAuthentication }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const query = request.query as { installmentId?: string; status?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 200);
    const result = await pool.query(`SELECT id, installment_id AS "installmentId", amount, retained_amount AS "retainedAmount", released_amount AS "releasedAmount", paid_at AS "paidAt", status, source, external_id AS "externalId", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM payments WHERE ($1::uuid IS NULL OR installment_id = $1::uuid) AND ($2 = '' OR status = $2)
      ORDER BY created_at DESC LIMIT $3`, [query.installmentId ?? null, query.status ?? '', limit]);
    return { items: result.rows, limit };
  });

  app.post('/api/v1/payments', { preHandler: requirePermission('finance:write') }, async (request, reply) => {
    const parsed = paymentSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid payment data', correlationId: request.id });
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const { installmentId, amount, paidAt, source, externalId } = parsed.data;
    const result = await pool.query(`INSERT INTO payments (installment_id, amount, paid_at, status, source, external_id)
      VALUES ($1, $2, $3, 'paid', $4, $5)
      RETURNING id, installment_id AS "installmentId", amount, retained_amount AS "retainedAmount", released_amount AS "releasedAmount", paid_at AS "paidAt", status, source, external_id AS "externalId", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [installmentId, amount, paidAt ? new Date(paidAt) : new Date(), source, externalId ?? null]);
    await recordAudit(pool, request.log, request.id, {
      action: 'payment.created',
      actorId: actorIdOf(request),
      entityType: 'payments',
      entityId: String(result.rows[0]?.id ?? '')
    });
    return reply.code(201).send(result.rows[0]);
  });

  app.get('/api/v1/schools/:schoolId/retention', { preHandler: requireAuthentication }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const { schoolId } = request.params as { schoolId: string };
    if (!z.string().uuid().safeParse(schoolId).success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid school id', correlationId: request.id });
    const result = await pool.query(`SELECT s.id, s.retention_enabled AS "retentionEnabled", s.retention_target_amount AS "targetAmount",
      COALESCE(SUM(r.amount), 0) AS "retainedAmount"
      FROM schools s LEFT JOIN retention_ledger r ON r.school_id = s.id
      WHERE s.id = $1 AND s.deleted_at IS NULL GROUP BY s.id`, [schoolId]);
    if (!result.rows[0]) return reply.code(404).send({ code: 'NOT_FOUND', message: 'School not found', correlationId: request.id });
    return result.rows[0];
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid login data', correlationId: request.id });
    }
    if (!pool) {
      return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Authentication is temporarily unavailable', correlationId: request.id });
    }

    const result = await pool.query<{
      id: string;
      password_hash: string;
      display_name: string;
      roles: string[] | null;
    }>(`SELECT u.id, u.password_hash, u.display_name,
               COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), ARRAY[]::text[]) AS roles
          FROM users u
          LEFT JOIN user_roles ur ON ur.user_id = u.id
          LEFT JOIN roles r ON r.id = ur.role_id
         WHERE u.email = $1 AND u.is_active = true
         GROUP BY u.id`, [parsed.data.email]);
    const user = result.rows[0];
    if (!user || !(await verifyPassword(parsed.data.password, user.password_hash))) {
      await recordAudit(pool, request.log, request.id, {
        action: 'auth.login.failed',
        metadata: { email: parsed.data.email }
      });
      return reply.code(401).send({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password', correlationId: request.id });
    }

    const session = await issueSession(pool, user.id, user.display_name, user.roles ?? [], request.headers['user-agent']);
    setRefreshCookie(reply, session.refreshToken);
    await recordAudit(pool, request.log, request.id, {
      action: 'auth.login.succeeded',
      actorId: user.id,
      entityType: 'auth_session',
      entityId: session.tokenId
    });
    return { accessToken: session.accessToken, tokenType: 'Bearer', expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  });

  /**
   * Rotates the refresh token: the presented session is revoked and a new one is issued.
   *
   * A refresh token is single-use; replaying one that was already rotated, revoked or expired is
   * refused with 401 and the cookie is cleared.
   */
  app.post('/api/v1/auth/refresh', async (request, reply) => {
    if (!pool) {
      return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Authentication is temporarily unavailable', correlationId: request.id });
    }
    const presented = readCookie(request.headers.cookie, config.refreshCookie.name);
    if (!presented) {
      clearRefresh(reply);
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Refresh token missing', correlationId: request.id });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<{
        token_id: string;
        user_id: string;
        display_name: string;
        roles: string[] | null;
      }>(`SELECT s.token_id, s.user_id, u.display_name,
                 COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), ARRAY[]::text[]) AS roles
            FROM auth_sessions s
            JOIN users u ON u.id = s.user_id
            LEFT JOIN user_roles ur ON ur.user_id = u.id
            LEFT JOIN roles r ON r.id = ur.role_id
           WHERE s.refresh_token_hash = $1
             AND s.revoked_at IS NULL
             AND s.refresh_expires_at > now()
             AND u.is_active = true
           GROUP BY s.id, s.token_id, s.user_id, u.display_name`,
        [hashRefreshToken(presented, config.refreshSecret)]);
      const current = found.rows[0];
      const revoked = current
        ? await client.query('UPDATE auth_sessions SET revoked_at = now() WHERE token_id = $1 AND revoked_at IS NULL', [current.token_id])
        : null;
      if (!current || revoked === null || revoked.rowCount === 0) {
        await client.query('ROLLBACK');
        clearRefresh(reply);
        await recordAudit(pool, request.log, request.id, { action: 'auth.refresh.rejected' });
        return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Refresh token is not valid anymore', correlationId: request.id });
      }
      const session = await issueSession(client, current.user_id, current.display_name, current.roles ?? [], request.headers['user-agent']);
      await client.query('COMMIT');
      setRefreshCookie(reply, session.refreshToken);
      await recordAudit(pool, request.log, request.id, {
        action: 'auth.refresh',
        actorId: current.user_id,
        entityType: 'auth_session',
        entityId: session.tokenId,
        metadata: { rotatedFrom: current.token_id }
      });
      return { accessToken: session.accessToken, tokenType: 'Bearer', expiresIn: ACCESS_TOKEN_TTL_SECONDS };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/api/v1/auth/logout', { preHandler: authenticate }, async (request, reply) => {
    const claims = request.user as { sub?: string; sid?: string };
    const refreshToken = readCookie(request.headers.cookie, config.refreshCookie.name);
    if (pool) {
      if (claims.sid) {
        await pool.query('UPDATE auth_sessions SET revoked_at = now() WHERE token_id = $1 AND revoked_at IS NULL', [claims.sid]);
      }
      if (refreshToken) {
        await pool.query('UPDATE auth_sessions SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL', [
          hashRefreshToken(refreshToken, config.refreshSecret)
        ]);
      }
    }
    clearRefresh(reply);
    await recordAudit(pool, request.log, request.id, {
      action: 'auth.logout',
      actorId: claims.sub || null,
      entityType: 'auth_session',
      entityId: claims.sid ?? null
    });
    return reply.code(204).send();
  });

  app.get('/api/v1/auth/me', { preHandler: authenticate }, async (request) => ({ user: request.user }));

  app.get('/api/v1/audit-logs', { preHandler: requirePermission('audit') }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const query = request.query as { action?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    const action = query.action?.trim() ?? '';
    const result = await pool.query(`SELECT id, action, entity_type AS "entityType", entity_id AS "entityId",
        correlation_id AS "correlationId", metadata, created_at AS "createdAt"
      FROM audit_logs
      WHERE ($1 = '' OR action = $1)
      ORDER BY created_at DESC LIMIT $2`, [action, limit]);
    return { items: result.rows, limit, action };
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: 'Route not found', correlationId: request.id }));
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    return reply.code(statusCode >= 400 ? statusCode : 500).send({ code: 'INTERNAL_ERROR', message: 'Unexpected error', correlationId: request.id });
  });
  return app;
}