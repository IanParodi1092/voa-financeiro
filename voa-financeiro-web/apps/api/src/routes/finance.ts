import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { patchSpecs } from '../domain/patch-specs.js';
import type { RouteDeps } from '../http/deps.js';
import { actorIdOf, requireAuthentication, requirePermission } from '../http/guards.js';

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

/** Cadeia financeira: acordos, parcelas, pagamentos e a retencao por escola. */
export function registerFinanceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { pool } = deps;
  const runPatch = deps.patchRunner;

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

  app.patch('/api/v1/agreements/:id', { preHandler: requirePermission('finance:write') }, (request, reply) =>
    runPatch(request, reply, patchSpecs.agreements));

  app.patch('/api/v1/installments/:id', { preHandler: requirePermission('finance:write') }, (request, reply) =>
    runPatch(request, reply, patchSpecs.installments));

  app.patch('/api/v1/payments/:id', { preHandler: requirePermission('finance:write') }, (request, reply) =>
    runPatch(request, reply, patchSpecs.payments));

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

}
