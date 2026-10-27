import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Pool } from 'pg';
import { recordAudit } from '../audit.js';
import { patchRow } from '../db/patch.js';
import type { PatchSpec } from '../domain/patch-specs.js';
import { actorIdOf } from './guards.js';

/**
 * Trava opcional de uma escrita: roda depois da validacao do corpo e antes do `UPDATE`.
 *
 * Devolve a resposta de recusa pronta (status, `code`, `message`) ou `null` quando o valor pode ser
 * gravado. Existe porque `patchRow` e generico e nem toda regra de negocio cabe no schema zod - a do
 * vinculo do guardiao depende de consultar o banco.
 */
export type PatchGuard = (context: {
  id: string;
  changes: Record<string, unknown>;
}) => Promise<{ status: number; code: string; message: string } | null>;

/**
 * Answers one PATCH: the body must carry at least one known field, only the sent fields are
 * written (plus `updated_at`) and the change is audited as `<entity>.updated` with the field names.
 *
 * `{}` is refused with `EMPTY_PATCH` after validation (the schema is partial, so zod accepts it) to
 * turn an accidental no-op into a precise error. `null` clears a nullable column; sending `""` is
 * rejected by the schema.
 */
export type PatchRunner = (
  request: FastifyRequest,
  reply: FastifyReply,
  spec: PatchSpec,
  guard?: PatchGuard
) => Promise<FastifyReply>;

/**
 * Executa um `PATCH` parcial sobre uma entidade com spec declarativa.
 *
 * O contrato e o mesmo para todas as entidades: a permissao segue o split de `POST`
 * (`catalog:write` para o catalogo, `finance:write` para a cadeia financeira) e a validacao do
 * corpo, a allowlist de colunas e a projecao devolvida vem de `patchSpecs`, entao um campo novo e
 * adicionado em um lugar so.
 */
export function createPatchRunner(pool: Pool | undefined): PatchRunner {
  return async (request, reply, spec, guard): Promise<FastifyReply> => {
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
}
