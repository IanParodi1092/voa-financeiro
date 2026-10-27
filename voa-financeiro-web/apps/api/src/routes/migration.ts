import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
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
} from '../db/migration-batches.js';
import {
  BATCH_STATUSES,
  COMMITTABLE_STATUSES,
  VALIDATABLE_STATUSES,
  canCommit,
  canValidate,
  evaluateGate,
  registerBatchSchema,
  resolveFindingSchema
} from '../domain/migration-batches.js';
import type { RouteDeps } from '../http/deps.js';
import { actorIdOf, requireAuthentication, requirePermission } from '../http/guards.js';

/**
 * Migracao: staging, gate e triagem.
 *
 * Estas rotas nao reexecutam as fases da migracao: perfil, staging, validacao e carga continuam nos
 * scripts Python de `docs/MIGRATION_WORKFLOW.md`, que sao os unicos que conhecem o dicionario de
 * campos. A API registra a fonte, mostra o que o validador gravou, fecha achado na triagem e sela o
 * lote quando nao sobrou bloqueio. Nenhuma tabela canonica e escrita por elas.
 */
export function registerMigrationRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { pool } = deps;

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
}
