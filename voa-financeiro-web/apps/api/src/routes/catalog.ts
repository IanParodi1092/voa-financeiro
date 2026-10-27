import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { checkGuardianCustomerLink, listGuardianLinkQueue, loadGuardianLinkCounts } from '../db/guardian-links.js';
import {
  GUARDIAN_LINK_STATUSES,
  GUARDIAN_LINK_TITLES,
  isGuardianLinkStatus,
  parseLinkOffset
} from '../domain/guardian-links.js';
import { patchSpecs } from '../domain/patch-specs.js';
import { parseDetailLimit } from '../domain/reconciliation.js';
import type { RouteDeps } from '../http/deps.js';
import { actorIdOf, requireAuthentication, requirePermission } from '../http/guards.js';

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
 * Catalogo: clientes, escolas, alunos, contatos, responsaveis e a fila de promocao
 * responsavel -> cliente.
 */
export function registerCatalogRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { pool } = deps;
  const runPatch = deps.patchRunner;

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
  app.patch('/api/v1/schools/:id', { preHandler: requirePermission('catalog:write') }, (request, reply) =>
    runPatch(request, reply, patchSpecs.schools));

  app.patch('/api/v1/customers/:id', { preHandler: requirePermission('catalog:write') }, (request, reply) =>
    runPatch(request, reply, patchSpecs.customers));

  app.patch('/api/v1/students/:id', { preHandler: requirePermission('catalog:write') }, (request, reply) =>
    runPatch(request, reply, patchSpecs.students));

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

}
