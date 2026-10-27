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
import { patchRow } from './db/patch.js';
import { patchSpecs, type PatchSpec } from './domain/patch-specs.js';
import {
  BATCH_STATUSES,
  COMMITTABLE_STATUSES,
  VALIDATABLE_STATUSES,
  canCommit,
  canValidate,
  evaluateGate,
  registerBatchSchema,
  resolveFindingSchema
} from './domain/migration-batches.js';
import {
  getBatch,
  listBatches,
  listFindings,
  loadFindingSummary,
  loadGateCounts,
  loadReconciliationReports,
  loadRowStatusCounts,
  registerBatch,
  resolveFinding,
  sealBatch
} from './db/migration-batches.js';
import {
  CHECK_TITLES,
  RECONCILIATION_CHECKS,
  classify,
  isReconciliationCheck,
  parseDetailLimit,
  summarize,
  type CheckOutcome,
  type ReconciliationCheck
} from './domain/reconciliation.js';
import {
  listAgreementInstallmentDivergences,
  listAgreementTotalDivergences,
  listProvenanceGaps,
  listUnresolvedLegacyKeys,
  loadAgreementInstallmentDivergence,
  loadAgreementTotalDivergence,
  loadCoverage,
  loadProvenance,
  loadUnresolvedLegacyKeys
} from './db/reconciliation-post-load.js';
import {
  GUARDIAN_LINK_STATUSES,
  GUARDIAN_LINK_TITLES,
  isGuardianLinkStatus,
  parseLinkOffset
} from './domain/guardian-links.js';
import {
  checkGuardianCustomerLink,
  listGuardianCustomerLinkDivergences,
  listGuardianLinkQueue,
  loadGuardianCustomerLinkDivergence,
  loadGuardianLinkCounts
} from './db/guardian-links.js';

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

/**
 * Detalhe de cada verificacao do relatorio pos-corte, por chave.
 *
 * Um mapa em vez da cadeia de ternarios que existia: com a quinta verificacao a cadeia virava
 * aninhamento de tres niveis, e uma chave nova passa a ser um erro de tipo aqui (o `Record` e
 * exaustivo) em vez de cair no `else` e devolver o detalhe da verificacao errada.
 */
const RECONCILIATION_DETAILS: Record<
  ReconciliationCheck,
  (pool: Pool, limit: number) => Promise<unknown[]>
> = {
  legacy_provenance: listProvenanceGaps,
  legacy_key_resolves: listUnresolvedLegacyKeys,
  agreement_total: listAgreementTotalDivergences,
  agreement_installments: listAgreementInstallmentDivergences,
  guardian_customer_link: listGuardianCustomerLinkDivergences
};

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

  /**
   * Trava opcional de uma escrita: roda depois da validacao do corpo e antes do `UPDATE`.
   *
   * Devolve a resposta de recusa pronta (status, `code`, `message`) ou `null` quando o valor pode
   * ser gravado. Existe porque `patchRow` e generico e nem toda regra de negocio cabe no schema zod
   * - a do vinculo do guardiao depende de consultar o banco.
   */
  type PatchGuard = (context: {
    id: string;
    changes: Record<string, unknown>;
  }) => Promise<{ status: number; code: string; message: string } | null>;

  /**
   * Answers one PATCH: the body must carry at least one known field, only the sent fields are
   * written (plus `updated_at`) and the change is audited as `<entity>.updated` with the field names.
   *
   * `{}` is refused with `EMPTY_PATCH` after validation (the schema is partial, so zod accepts it)
   * to turn an accidental no-op into a precise error. `null` clears a nullable column; sending `""`
   * is rejected by the schema.
   */
  const runPatch = async (
    request: FastifyRequest,
    reply: FastifyReply,
    spec: PatchSpec,
    guard?: PatchGuard
  ): Promise<FastifyReply> => {
    const { id } = request.params as { id?: string };
    if (!id || !z.string().uuid().safeParse(id).success) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid id', correlationId: request.id });
    }
    const parsed = spec.schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: `Invalid ${spec.entityType} data`, correlationId: request.id });
    }
    const changes = parsed.data;
    const fields = Object.keys(changes);
    if (fields.length === 0) {
      return reply.code(400).send({ code: 'EMPTY_PATCH', message: 'At least one field must be provided', correlationId: request.id });
    }
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });

    if (guard) {
      const refused = await guard({ id, changes });
      if (refused) {
        return reply.code(refused.status).send({ code: refused.code, message: refused.message, correlationId: request.id });
      }
    }

    const columns: Record<string, unknown> = {};
    for (const field of fields) {
      const column = spec.columns[field];
      if (!column) throw new Error(`patch spec ${spec.entityType} has no column for ${field}`);
      columns[column] = changes[field];
    }

    const outcome = await patchRow(pool, spec, id, columns);
    if (outcome.status === 'not_found') {
      return reply.code(404).send({ code: 'NOT_FOUND', message: `${spec.entityType} not found`, correlationId: request.id });
    }
    if (outcome.status === 'conflict') {
      return reply.code(409).send({ code: 'CONFLICT', message: 'The change conflicts with an existing record', correlationId: request.id });
    }
    if (outcome.status === 'invalid_reference') {
      return reply.code(400).send({ code: 'INVALID_REFERENCE', message: 'A referenced record does not exist', correlationId: request.id });
    }
    if (outcome.status === 'invalid_value') {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: `A value is not accepted by the ${spec.entityType} schema`, correlationId: request.id });
    }

    await recordAudit(pool, request.log, request.id, {
      action: spec.auditAction,
      actorId: actorIdOf(request),
      entityType: spec.entityType,
      entityId: id,
      metadata: { fields }
    });
    return reply.code(200).send(outcome.row);
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

  app.get('/api/v1/students/:studentId/guardians', { preHandler: requireAuthentication }, async (request, reply) => {
    const { studentId } = request.params as { studentId: string };
    // Um id malformado e erro do cliente: responde 400 mesmo com o banco fora.
    if (!z.string().uuid().safeParse(studentId).success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid student id', correlationId: request.id });
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const result = await pool.query(`SELECT id, student_id AS "studentId", customer_id AS "customerId", full_name AS "fullName",
        document_number AS "documentNumber", document_rg AS "documentRg", marital_status AS "maritalStatus", occupation,
        is_financial AS "isFinancial", is_verified AS "isVerified", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM guardians WHERE student_id = $1 AND deleted_at IS NULL ORDER BY is_financial DESC, full_name`, [studentId]);
    return { items: result.rows };
  });

  // -----------------------------------------------------------------------------------------------
  // Promocao responsavel -> cliente (assistida).
  //
  // A `0011` deixou `guardians.customer_id` nulo e `is_verified` falso porque **nome do legado nunca
  // vira cliente**. Esta secao nao muda essa regra: a fila mostra o que a estrutura do dado ja
  // sustenta (o pagador dos acordos do proprio aluno com o mesmo nome do responsavel) e a escrita
  // continua sendo o `PATCH /api/v1/guardians/:id`, que exige o mesmo pagador e audita o par que uma
  // **pessoa** confirmou.
  //
  // Por que o candidato nao sai de `customers` inteiro: 24.696 dos 26.264 clientes sao escolas e
  // empresas de `TBL_CLIENTE` (CNPJ), e os 1.568 restantes sao o pagador sintetizado de
  // `TBL_PAGAMENTO`. O universo util e `agreements.customer_id` do aluno do guardiao - e essa mesma
  // condicao e a trava do PATCH, que recusa vincular um responsavel a escola.
  // -----------------------------------------------------------------------------------------------

  /**
   * Fila de conciliacao: 6.347 guardioes classificados em `single`, `ambiguous`, `no_match`,
   * `no_payer` e `linked`.
   *
   * `counts` volta sempre completo (mesmo com `status`), para a tela mostrar o tamanho de cada aba
   * sem uma chamada por filtro. Medido no canonico local em 2026-10-27: 274 `single`, 102
   * `ambiguous`, 774 `no_match`, 5.197 `no_payer`, 0 `linked`.
   */
  app.get('/api/v1/guardians/customer-candidates', { preHandler: requireAuthentication }, async (request, reply) => {
    const query = request.query as { status?: string; limit?: string; offset?: string };
    const status = query.status?.trim() || undefined;
    if (status !== undefined && !isGuardianLinkStatus(status)) {
      return reply.code(400).send({
        code: 'INVALID_REQUEST',
        message: `status must be one of ${GUARDIAN_LINK_STATUSES.join(', ')}`,
        correlationId: request.id
      });
    }
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const limit = parseDetailLimit(query.limit);
    const offset = parseLinkOffset(query.offset);
    const [items, counts] = await Promise.all([
      listGuardianLinkQueue(pool, { status, limit, offset }),
      loadGuardianLinkCounts(pool)
    ]);
    return { generatedAt: new Date().toISOString(), status: status ?? null, limit, offset, titles: GUARDIAN_LINK_TITLES, counts, items };
  });


  app.get('/api/v1/students/:studentId/contacts', { preHandler: requireAuthentication }, async (request, reply) => {
    const { studentId } = request.params as { studentId: string };
    if (!z.string().uuid().safeParse(studentId).success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid student id', correlationId: request.id });
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const result = await pool.query(`SELECT id, student_id AS "studentId", type, value, is_primary AS "isPrimary",
        is_verified AS "isVerified", status, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM student_contacts WHERE student_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC, type, value`, [studentId]);
    return { items: result.rows };
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
    const result = await pool.query(`SELECT id, installment_id AS "installmentId", amount, retained_amount AS "retainedAmount", released_amount AS "releasedAmount", paid_at AS "paidAt", status, source, external_id AS "externalId",
        retention_status AS "retentionStatus", retention_percentage AS "retentionPercentage", retention_approved_at AS "retentionApprovedAt",
        retention_scheduled_month AS "retentionScheduledMonth", retention_released_at AS "retentionReleasedAt",
        created_at AS "createdAt", updated_at AS "updatedAt"
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

  /**
   * PATCH contracts: partial updates of the domain rows.
   *
   * Permission follows the same split as `POST` (`catalog:write` for the catalog, `finance:write`
   * for the financial chain) and the body validation, the column allowlist and the returned
   * projection all come from `patchSpecs`, so a new field is added in a single place.
   */
  app.patch('/api/v1/schools/:id', { preHandler: requirePermission('catalog:write') }, (request, reply) =>
    runPatch(request, reply, patchSpecs.schools));

  app.patch('/api/v1/customers/:id', { preHandler: requirePermission('catalog:write') }, (request, reply) =>
    runPatch(request, reply, patchSpecs.customers));

  app.patch('/api/v1/students/:id', { preHandler: requirePermission('catalog:write') }, (request, reply) =>
    runPatch(request, reply, patchSpecs.students));

  app.patch('/api/v1/agreements/:id', { preHandler: requirePermission('finance:write') }, (request, reply) =>
    runPatch(request, reply, patchSpecs.agreements));

  app.patch('/api/v1/installments/:id', { preHandler: requirePermission('finance:write') }, (request, reply) =>
    runPatch(request, reply, patchSpecs.installments));

  app.patch('/api/v1/payments/:id', { preHandler: requirePermission('finance:write') }, (request, reply) =>
    runPatch(request, reply, patchSpecs.payments));

  app.patch('/api/v1/guardians/:id', { preHandler: requirePermission('catalog:write') }, (request, reply) =>
    runPatch(request, reply, patchSpecs.guardians, async ({ id, changes }) => {
      /**
       * Trava do vinculo responsavel -> cliente.
       *
       * `customerId: null` desfaz o vinculo (nada a conferir) e a ausencia do campo nao muda nada;
       * so um uuid precisa passar. Sem esta trava o PATCH aceitaria qualquer um dos 26.264 clientes,
       * e 24.696 deles sao escolas/empresas de `TBL_CLIENTE` - promover um responsavel a escola nao
       * e conciliacao, e erro de digitacao.
       */
      const customerId = changes.customerId;
      if (typeof customerId !== 'string' || !pool) return null;
      const check = await checkGuardianCustomerLink(pool, id, customerId);
      if (check === 'ok') return null;
      if (check === 'guardian_not_found') return { status: 404, code: 'NOT_FOUND', message: 'Guardian not found' };
      if (check === 'customer_not_found') {
        return { status: 400, code: 'INVALID_REFERENCE', message: 'Customer does not exist' };
      }
      return {
        status: 409,
        code: 'CUSTOMER_NOT_PAYER',
        message: 'Customer does not pay any agreement of this guardian student'
      };
    }));

  app.patch('/api/v1/student-contacts/:id', { preHandler: requirePermission('catalog:write') }, (request, reply) =>
    runPatch(request, reply, patchSpecs.studentContacts));

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

  // -----------------------------------------------------------------------------------------------
  // Migracao: staging, gate e triagem
  //
  // Estas rotas nao reexecutam as fases da migracao: perfil, staging, validacao e carga continuam
  // nos scripts Python de `docs/MIGRATION_WORKFLOW.md`, que sao os unicos que conhecem o dicionario
  // de campos. A API registra a fonte, mostra o que o validador gravou, fecha achado na triagem e
  // sela o lote quando nao sobrou bloqueio. Nenhuma tabela canonica e escrita por elas.
  // -----------------------------------------------------------------------------------------------

  /**
   * Registra a fonte de um lote em `profiled` (idempotente por `source_name` + `source_hash`).
   *
   * Repetir o mesmo arquivo devolve o lote existente com 200 e `duplicate: true`, para o operador
   * nao criar um segundo lote ao rodar o staging duas vezes.
   */
  app.post('/api/v1/migrations/batches', { preHandler: requirePermission('migration:write') }, async (request, reply) => {
    const parsed = registerBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid migration batch data', correlationId: request.id });
    }
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const { batch, duplicate } = await registerBatch(pool, parsed.data);
    if (!duplicate) {
      await recordAudit(pool, request.log, request.id, {
        action: 'migration.batch.registered',
        actorId: actorIdOf(request),
        entityType: 'migration_batches',
        entityId: batch.id,
        metadata: { sourceName: batch.sourceName, sourceKind: batch.sourceKind, rowCount: batch.rowCount }
      });
    }
    return reply.code(duplicate ? 200 : 201).send({ ...batch, duplicate });
  });

  app.get('/api/v1/migrations/batches', { preHandler: requireAuthentication }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const query = request.query as { status?: string; limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    const status = query.status ?? '';
    if (status !== '' && !(BATCH_STATUSES as readonly string[]).includes(status)) {
      return reply.code(400).send({
        code: 'INVALID_REQUEST',
        message: `status must be one of ${BATCH_STATUSES.join(', ')}`,
        correlationId: request.id
      });
    }
    const items = await listBatches(pool, { status, limit });
    return { items, limit, status: status === '' ? null : status };
  });

  /**
   * Visao de um lote: contagens por status de linha, achados por severidade, relatorios de
   * reconciliacao e o veredito dos dois gates (o mesmo que `validate` e `commit` aplicam).
   */
  app.get('/api/v1/migrations/batches/:id', { preHandler: requireAuthentication }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid batch id', correlationId: request.id });
    }
    const batch = await getBatch(pool, id);
    if (!batch) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Migration batch not found', correlationId: request.id });
    const [counts, byStatus, findings, reconciliation] = await Promise.all([
      loadGateCounts(pool, id),
      loadRowStatusCounts(pool, id),
      loadFindingSummary(pool, id),
      loadReconciliationReports(pool, id)
    ]);
    return {
      ...batch,
      rows: { total: counts.rowsTotal, inError: counts.rowsInError, byStatus },
      findings,
      reconciliation,
      gate: { validate: evaluateGate(counts, 'validate'), commit: evaluateGate(counts, 'commit') }
    };
  });

  /**
   * Achados do lote, do mais antigo para o mais novo. `resolved=false` devolve so o que ainda
   * bloqueia o gate; `details` nunca sai daqui (carrega valor da planilha legada).
   */
  app.get('/api/v1/migrations/batches/:id/errors', { preHandler: requireAuthentication }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid batch id', correlationId: request.id });
    }
    const query = request.query as { severity?: string; resolved?: string; limit?: string };
    const severity = query.severity ?? '';
    if (severity !== '' && !['warning', 'error', 'blocking'].includes(severity)) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'severity must be warning, error or blocking', correlationId: request.id });
    }
    if (query.resolved !== undefined && query.resolved !== 'true' && query.resolved !== 'false') {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'resolved must be true or false', correlationId: request.id });
    }
    const resolved = query.resolved === undefined ? undefined : query.resolved === 'true';
    const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 200);
    const batch = await getBatch(pool, id);
    if (!batch) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Migration batch not found', correlationId: request.id });
    const items = await listFindings(pool, id, { severity, resolved, limit });
    return { items, limit, severity: severity === '' ? null : severity, resolved: resolved ?? null };
  });

  /**
   * Recalcula o gate e sela o lote como `validated` ou `committed`.
   *
   * Nao reexecuta o validador nem a carga: confere o que eles deixaram gravado. `BATCH_NOT_READY`
   * devolve `blockers` e as contagens para a tela dizer exatamente o que falta resolver;
   * `INVALID_STATUS` recusa lote `committed`, `rolled_back` ou `failed`.
   */
  const sealBatchStage = async (
    request: FastifyRequest,
    reply: FastifyReply,
    stage: 'validate' | 'commit'
  ): Promise<FastifyReply> => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const { id } = request.params as { id?: string };
    if (!id || !z.string().uuid().safeParse(id).success) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid batch id', correlationId: request.id });
    }
    const batch = await getBatch(pool, id);
    if (!batch) return reply.code(404).send({ code: 'NOT_FOUND', message: 'Migration batch not found', correlationId: request.id });
    const allowed = stage === 'validate' ? canValidate(batch.status) : canCommit(batch.status);
    if (!allowed) {
      return reply.code(409).send({
        code: 'INVALID_STATUS',
        message: `Batch is ${batch.status} and cannot be ${stage === 'validate' ? 'validated' : 'committed'}`,
        status: batch.status,
        correlationId: request.id
      });
    }
    const counts = await loadGateCounts(pool, id);
    const gate = evaluateGate(counts, stage);
    if (!gate.ok) {
      return reply.code(409).send({
        code: 'BATCH_NOT_READY',
        message: 'The staging still has unresolved findings',
        blockers: gate.blockers,
        counts,
        correlationId: request.id
      });
    }
    const sealed = await sealBatch(
      pool,
      id,
      stage === 'validate' ? 'validated' : 'committed',
      stage === 'validate' ? VALIDATABLE_STATUSES : COMMITTABLE_STATUSES
    );
    if (!sealed) {
      return reply.code(409).send({ code: 'INVALID_STATUS', message: 'Batch status changed while sealing', correlationId: request.id });
    }
    await recordAudit(pool, request.log, request.id, {
      action: stage === 'validate' ? 'migration.batch.validated' : 'migration.batch.committed',
      actorId: actorIdOf(request),
      entityType: 'migration_batches',
      entityId: id,
      metadata: { previousStatus: batch.status, rows: counts.rowsTotal, findings: counts.openFindings }
    });
    return reply.code(200).send({ ...sealed, counts, gate });
  };

  app.post('/api/v1/migrations/batches/:id/validate', { preHandler: requirePermission('migration:write') }, (request, reply) =>
    sealBatchStage(request, reply, 'validate'));

  app.post('/api/v1/migrations/batches/:id/commit', { preHandler: requirePermission('migration:write') }, (request, reply) =>
    sealBatchStage(request, reply, 'commit'));

  /**
   * Fecha um achado na triagem. A nota opcional vai para `details.resolution` e o evento para
   * `audit_logs`; resolver duas vezes devolve 200 com `duplicate: true` e a data original.
   */
  app.post('/api/v1/migrations/errors/:id/resolve', { preHandler: requirePermission('migration:write') }, async (request, reply) => {
    const { id } = request.params as { id?: string };
    if (!id || !z.string().uuid().safeParse(id).success) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid finding id', correlationId: request.id });
    }
    const parsed = resolveFindingSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid resolution data', correlationId: request.id });
    }
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const outcome = await resolveFinding(pool, id, parsed.data.note, actorIdOf(request));
    if (outcome.status === 'not_found') {
      return reply.code(404).send({ code: 'NOT_FOUND', message: 'Migration finding not found', correlationId: request.id });
    }
    if (outcome.status === 'resolved') {
      await recordAudit(pool, request.log, request.id, {
        action: 'migration.finding.resolved',
        actorId: actorIdOf(request),
        entityType: 'migration_errors',
        entityId: id,
        metadata: {
          errorCode: outcome.finding.errorCode,
          severity: outcome.finding.severity,
          note: parsed.data.note ?? null
        }
      });
    }
    return reply.code(200).send({ ...outcome.finding, duplicate: outcome.status === 'already_resolved' });
  });

  // -----------------------------------------------------------------------------------------------
  // Conciliacao pos-corte (somente leitura).
  //
  // Confere o que ficou **gravado** depois da carga: proveniencia legada, chave legada resolvendo no
  // staging e as duas somas do acordo. Nao corrige nada - a correcao continua sendo uma rodada da
  // carga (`--commit`) ou do backfill, com decisao explicita do operador.
  //
  // `payments` e `users` ficam fora da proveniencia de proposito: o primeiro nao tem colunas
  // `legacy_*` (nasce da aplicacao e do webhook Asaas) e o segundo e criado por `auth:create-admin`.
  // -----------------------------------------------------------------------------------------------

  /**
   * Relatorio completo: as cinco verificacoes + a cobertura por entidade.
   *
   * `ok` so e `true` quando todas estao zeradas. A cobertura vem junto porque o operador precisa
   * comparar a rodada com a anterior (`stagedRows` x `canonicalRows` x `pendingCanonicalKeys`), nao
   * porque ela seja um gate.
   */
  app.get('/api/v1/reconciliation/post-load', { preHandler: requireAuthentication }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const [provenance, unresolved, agreementTotal, agreementInstallments, guardianLinks, coverage] = await Promise.all([
      loadProvenance(pool),
      loadUnresolvedLegacyKeys(pool),
      loadAgreementTotalDivergence(pool),
      loadAgreementInstallmentDivergence(pool),
      loadGuardianCustomerLinkDivergence(pool),
      loadCoverage(pool)
    ]);
    const withoutProvenance = provenance.reduce((total, row) => total + row.withoutProvenance, 0);
    const unresolvedKeys = unresolved.reduce((total, row) => total + row.unresolvedLegacyKeys, 0);
    const outcomes = [
      { key: 'legacy_provenance', divergent: withoutProvenance },
      { key: 'legacy_key_resolves', divergent: unresolvedKeys },
      { key: 'agreement_total', divergent: agreementTotal.divergent },
      { key: 'agreement_installments', divergent: agreementInstallments },
      { key: 'guardian_customer_link', divergent: guardianLinks }
    ] satisfies CheckOutcome[];
    const summary = summarize(outcomes);
    const checks = [
      {
        key: 'legacy_provenance' as const,
        title: CHECK_TITLES.legacy_provenance,
        status: classify(withoutProvenance),
        divergent: withoutProvenance,
        entities: provenance
      },
      {
        key: 'legacy_key_resolves' as const,
        title: CHECK_TITLES.legacy_key_resolves,
        status: classify(unresolvedKeys),
        divergent: unresolvedKeys,
        entities: unresolved
      },
      {
        key: 'agreement_total' as const,
        title: CHECK_TITLES.agreement_total,
        status: classify(agreementTotal.divergent),
        divergent: agreementTotal.divergent,
        deltaAmount: agreementTotal.deltaAmount ?? '0.00'
      },
      {
        key: 'agreement_installments' as const,
        title: CHECK_TITLES.agreement_installments,
        status: classify(agreementInstallments),
        divergent: agreementInstallments
      },
      {
        key: 'guardian_customer_link' as const,
        title: CHECK_TITLES.guardian_customer_link,
        status: classify(guardianLinks),
        divergent: guardianLinks
      }
    ];
    return { generatedAt: new Date().toISOString(), ...summary, checks, coverage };
  });

  /**
   * Detalhe (paginado por `limit`, no maximo 200) das linhas que sobraram em uma verificacao.
   *
   * O detalhe e recalculado a cada chamada: nao ha snapshot guardado, entao o numero do detalhe
   * sempre concorda com o do relatorio no mesmo instante.
   */
  app.get('/api/v1/reconciliation/post-load/:check', { preHandler: requireAuthentication }, async (request, reply) => {
    const { check } = request.params as { check: string };
    if (!isReconciliationCheck(check)) {
      return reply.code(400).send({
        code: 'INVALID_REQUEST',
        message: `check must be one of ${RECONCILIATION_CHECKS.join(', ')}`,
        correlationId: request.id
      });
    }
    const limit = parseDetailLimit((request.query as { limit?: string }).limit);
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const items = await RECONCILIATION_DETAILS[check](pool, limit);
    return { check, title: CHECK_TITLES[check], limit, items };
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
