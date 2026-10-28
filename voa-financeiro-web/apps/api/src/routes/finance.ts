import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { enqueueOutbox } from '../db/outbox.js';
import { chargeDedupeKey, chargeDescription, customerCreatePayload, customerDedupeKey } from '../domain/outbox.js';
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

/**
 * `UNDEFINED` e o default de proposito: o pagador escolhe boleto, PIX ou cartao na fatura do Asaas,
 * e a escola nao precisa decidir por parcela. Quem quiser forcar um meio manda `billingType`.
 */
const chargeRequestSchema = z.object({
  billingType: z.enum(['BOLETO', 'PIX', 'CREDIT_CARD', 'UNDEFINED']).default('UNDEFINED')
});

const uuidSchema = z.string().uuid();

/** Falha que a rota decide antes/depois do `COMMIT`; o corpo ganha `correlationId` na resposta. */
interface RouteFailure {
  status: number;
  body: { code: string; message: string };
}

/** Cadeia financeira: acordos, parcelas, pagamentos e a retencao por escola. */
export function registerFinanceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { pool, config } = deps;
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

  /**
   * Sincroniza o cliente com o Asaas: enfileira `asaas.customer.create`.
   *
   * E pre-requisito de `POST /installments/:id/charge` (a cobranca usa o id do cliente no provedor),
   * e por isso mora ao lado dela, com `finance:write`, e nao no catalogo. Idempotente dos dois lados:
   * `customerDedupeKey` impede duas linhas na fila e um cliente que ja tem `asaas_customers`
   * responde `synced: true` sem enfileirar nada.
   */
  app.post('/api/v1/customers/:id/asaas', { preHandler: requirePermission('finance:write') }, async (request, reply) => {
    const parsedId = uuidSchema.safeParse((request.params as { id?: string }).id);
    if (!parsedId.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid customer id', correlationId: request.id });
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });

    const customerId = parsedId.data;
    const dedupeKey = customerDedupeKey(customerId);
    let failure: RouteFailure | null = null;
    let queued = false;
    let synced: { asaasCustomerId: string; externalId: string } | null = null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<{
        fullName: string;
        documentNumber: string | null;
        email: string | null;
        phone: string | null;
        asaasCustomerId: string | null;
        externalId: string | null;
      }>(
        `SELECT c.full_name AS "fullName", c.document_number AS "documentNumber", c.email, c.phone,
                ac.id AS "asaasCustomerId", ac.external_id AS "externalId"
           FROM customers c
           LEFT JOIN asaas_customers ac ON ac.customer_id = c.id
          WHERE c.id = $1 AND c.deleted_at IS NULL
          FOR UPDATE OF c`,
        [customerId]
      );
      const row = found.rows[0];
      if (!row) {
        failure = { status: 404, body: { code: 'CUSTOMER_NOT_FOUND', message: 'Customer not found' } };
      } else if (row.asaasCustomerId !== null && row.externalId !== null) {
        synced = { asaasCustomerId: row.asaasCustomerId, externalId: row.externalId };
      } else {
        queued = await enqueueOutbox(
          client,
          {
            topic: 'asaas.customer.create',
            dedupeKey,
            payload: customerCreatePayload({
              customerId,
              fullName: row.fullName,
              documentNumber: row.documentNumber,
              email: row.email,
              phone: row.phone
            }),
            entity: { type: 'customers', id: customerId },
            correlationId: request.id
          },
          { environment: config.ASAAS_ENVIRONMENT, maxAttempts: config.OUTBOX_MAX_ATTEMPTS }
        );
      }
      await client.query(failure === null ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      // Um `COMMIT` ja feito falha no rollback com "no transaction in progress"; nada a desfazer.
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (failure) return reply.code(failure.status).send({ ...failure.body, correlationId: request.id });
    if (synced) return { customerId, queued: false, synced: true, ...synced };
    if (queued) {
      await recordAudit(pool, request.log, request.id, {
        action: 'customer.asaas_sync_requested',
        actorId: actorIdOf(request),
        entityType: 'customers',
        entityId: customerId,
        metadata: { dedupeKey }
      });
    }
    deps.outbox?.wake();
    return reply.code(queued ? 202 : 200).send({ customerId, queued, dedupeKey });
  });

  /**
   * Gera a cobranca de uma parcela: enfileira `asaas.charge.create`.
   *
   * Decisao de negocio (`docs/OUTBOX_DESIGN.md`, secao 15, item 1): cobrar e acao **explicita**,
   * nunca efeito de criar parcela ou de importar o legado. Cada recusa acontece antes de enfileirar e
   * diz o que falta: parcela inexistente (404), parcela que nao esta mais `pending` ou sem valor
   * (409 `INSTALLMENT_NOT_BILLABLE`) e cliente sem `asaas_customers` (409 `CUSTOMER_NOT_SYNCED`, com
   * a rota que resolve).
   *
   * `queued: false` com 200 e o `POST` repetido: a `dedupeKey` da parcela ja estava na fila. Para
   * reenviar uma cobranca que morreu, o caminho e `POST /api/v1/ops/outbox/:id/retry`.
   */
  app.post('/api/v1/installments/:id/charge', { preHandler: requirePermission('finance:write') }, async (request, reply) => {
    const parsedId = uuidSchema.safeParse((request.params as { id?: string }).id);
    if (!parsedId.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid installment id', correlationId: request.id });
    const parsedBody = chargeRequestSchema.safeParse(request.body ?? {});
    if (!parsedBody.success) return reply.code(400).send({ code: 'INVALID_REQUEST', message: 'Invalid charge request', correlationId: request.id });
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });

    const installmentId = parsedId.data;
    const { billingType } = parsedBody.data;
    const dedupeKey = chargeDedupeKey(installmentId);
    let failure: RouteFailure | null = null;
    let queued = false;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<{
        installmentNumber: number;
        status: string;
        dueDate: string;
        originalAmount: string;
        reference: string | null;
        installmentsCount: number;
        asaasCustomerId: string | null;
      }>(
        `SELECT i.installment_number AS "installmentNumber", i.status,
                to_char(i.due_date, 'YYYY-MM-DD') AS "dueDate", i.original_amount AS "originalAmount",
                a.reference, a.installments_count AS "installmentsCount", ac.id AS "asaasCustomerId"
           FROM installments i
           JOIN agreements a ON a.id = i.agreement_id
           LEFT JOIN asaas_customers ac ON ac.customer_id = a.customer_id
          WHERE i.id = $1 AND i.deleted_at IS NULL
          FOR UPDATE OF i`,
        [installmentId]
      );
      const row = found.rows[0];
      if (!row) {
        failure = { status: 404, body: { code: 'INSTALLMENT_NOT_FOUND', message: 'Installment not found' } };
      } else if (row.status !== 'pending') {
        failure = { status: 409, body: { code: 'INSTALLMENT_NOT_BILLABLE', message: `Installment is ${row.status}` } };
      } else if (Number(row.originalAmount) <= 0) {
        failure = {
          status: 409,
          body: { code: 'INSTALLMENT_NOT_BILLABLE', message: 'Installment has no amount to charge' }
        };
      } else if (row.asaasCustomerId === null) {
        failure = {
          status: 409,
          body: {
            code: 'CUSTOMER_NOT_SYNCED',
            message: 'Customer has no Asaas registration; POST /api/v1/customers/:id/asaas first'
          }
        };
      } else {
        queued = await enqueueOutbox(
          client,
          {
            topic: 'asaas.charge.create',
            dedupeKey,
            payload: {
              installmentId,
              asaasCustomerId: row.asaasCustomerId,
              billingType,
              value: Number(row.originalAmount),
              dueDate: row.dueDate,
              description: chargeDescription({
                installmentNumber: row.installmentNumber,
                installmentsCount: row.installmentsCount,
                reference: row.reference
              })
            },
            entity: { type: 'installments', id: installmentId },
            correlationId: request.id
          },
          { environment: config.ASAAS_ENVIRONMENT, maxAttempts: config.OUTBOX_MAX_ATTEMPTS }
        );
      }
      await client.query(failure === null ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    if (failure) return reply.code(failure.status).send({ ...failure.body, correlationId: request.id });
    if (queued) {
      await recordAudit(pool, request.log, request.id, {
        action: 'installment.charge_requested',
        actorId: actorIdOf(request),
        entityType: 'installments',
        entityId: installmentId,
        metadata: { dedupeKey, billingType }
      });
    }
    deps.outbox?.wake();
    return reply.code(queued ? 202 : 200).send({ installmentId, dedupeKey, queued });
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
