import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from 'pg';

export interface AuditEntry {
  action: string;
  actorId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append one row to `audit_logs`.
 *
 * Auditing must never break the request it describes: a failure is logged as a warning and
 * swallowed. The actor is kept inside `metadata` because `audit_logs` has no actor column yet.
 */
export async function recordAudit(
  pool: Pool | undefined,
  logger: FastifyBaseLogger,
  correlationId: string,
  entry: AuditEntry
): Promise<void> {
  if (!pool) return;
  const metadata = { ...entry.metadata };
  if (entry.actorId) metadata.actorId = entry.actorId;
  try {
    await pool.query(
      `INSERT INTO audit_logs (action, entity_type, entity_id, correlation_id, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.action, entry.entityType ?? null, entry.entityId ?? null, correlationId, JSON.stringify(metadata)]
    );
  } catch (error) {
    logger.warn({ err: error, action: entry.action }, 'audit log write failed');
  }
}
