import type { Pool } from 'pg';
import type { BatchStatus, GateCounts, RegisterBatchInput } from '../domain/migration-batches.js';

/**
 * Consultas dos lotes de migracao.
 *
 * O modulo so le e sela o staging: nenhuma tabela canonica (`schools`, `agreements`, `payments`...)
 * e escrita aqui. A carga continua em `scripts/load_canonical_batch.py`, que e o unico lugar com o
 * dicionario de campos.
 */

/**
 * Projecao em camelCase de `migration_batches`.
 *
 * O `payload`/`normalized_payload` das linhas nunca sai por estas consultas: o staging guarda dado
 * pessoal do legado e a API so precisa dos metadados.
 */
const BATCH_COLUMNS = `id, source_name AS "sourceName", source_hash AS "sourceHash",
  source_kind AS "sourceKind", status, row_count AS "rowCount", started_at AS "startedAt",
  completed_at AS "completedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

const FINDING_COLUMNS = `id, error_code AS "errorCode", severity, field_name AS "fieldName", message,
  row_id AS "rowId", created_at AS "createdAt", resolved_at AS "resolvedAt"`;

/** Mesma projecao de `FINDING_COLUMNS`, qualificada pelo alias da tabela (o JOIN com as linhas tem `id` nos dois lados). */
const findingColumns = (alias: string): string => `${alias}id, ${alias}error_code AS "errorCode", ${alias}severity,
  ${alias}field_name AS "fieldName", ${alias}message, ${alias}row_id AS "rowId",
  ${alias}created_at AS "createdAt", ${alias}resolved_at AS "resolvedAt"`;

export interface BatchRecord {
  id: string;
  sourceName: string;
  sourceHash: string;
  sourceKind: string;
  status: BatchStatus;
  rowCount: number;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BatchSummary extends BatchRecord {
  rows: number;
  openFindings: number;
}

export interface FindingRecord {
  id: string;
  errorCode: string;
  severity: 'warning' | 'error' | 'blocking';
  fieldName: string | null;
  message: string;
  rowId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface FindingListItem extends FindingRecord {
  sourceSheet: string | null;
  sourceRowNumber: number | null;
}

export interface ReconciliationRecord {
  entityName: string;
  sourceCount: number;
  stagedCount: number;
  canonicalCount: number;
  sourceTotal: string | null;
  canonicalTotal: string | null;
  duplicateCandidates: number;
  blockingErrors: number;
  notes: string | null;
  createdAt: Date;
}

export type ResolveOutcome =
  | { status: 'resolved'; finding: FindingRecord }
  | { status: 'already_resolved'; finding: FindingRecord }
  | { status: 'not_found' };

/**
 * Registra a fonte do lote em `profiled`, com a hash como chave de idempotencia.
 *
 * `ON CONFLICT DO NOTHING` + leitura do lote existente: a API nunca apaga um lote (o script de
 * staging apaga o proprio lote `failed` antes de reestagiar), entao repetir o registro devolve o
 * lote anterior com `duplicate: true` em vez de 409.
 */
export async function registerBatch(
  pool: Pool,
  input: RegisterBatchInput
): Promise<{ batch: BatchRecord; duplicate: boolean }> {
  const inserted = await pool.query<BatchRecord>(
    `INSERT INTO migration_batches (source_name, source_hash, source_kind, status, row_count, started_at)
     VALUES ($1, $2, $3, 'profiled', $4, now())
     ON CONFLICT (source_name, source_hash) DO NOTHING
     RETURNING ${BATCH_COLUMNS}`,
    [input.sourceName, input.sourceHash, input.sourceKind, input.rowCount]
  );
  const created = inserted.rows[0];
  if (created) return { batch: created, duplicate: false };

  const existing = await pool.query<BatchRecord>(
    `SELECT ${BATCH_COLUMNS} FROM migration_batches WHERE source_name = $1 AND source_hash = $2`,
    [input.sourceName, input.sourceHash]
  );
  const batch = existing.rows[0];
  if (!batch) throw new Error('batch vanished between insert and select');
  return { batch, duplicate: true };
}

/** Lotes mais recentes, com o total de linhas estagiadas e de achados ainda abertos. */
export async function listBatches(
  pool: Pool,
  filters: { status?: string; limit: number }
): Promise<BatchSummary[]> {
  const result = await pool.query<BatchSummary>(
    `SELECT ${BATCH_COLUMNS},
       (SELECT count(*)::int FROM migration_rows r WHERE r.batch_id = b.id) AS rows,
       (SELECT count(*)::int FROM migration_errors e WHERE e.batch_id = b.id AND e.resolved_at IS NULL) AS "openFindings"
     FROM migration_batches b
     WHERE ($1 = '' OR b.status = $1)
     ORDER BY b.created_at DESC
     LIMIT $2`,
    [filters.status ?? '', filters.limit]
  );
  return result.rows;
}

export async function getBatch(pool: Pool, id: string): Promise<BatchRecord | null> {
  const result = await pool.query<BatchRecord>(
    `SELECT ${BATCH_COLUMNS} FROM migration_batches WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

/** Contagens do gate, todas em uma ida ao banco. */
export async function loadGateCounts(pool: Pool, batchId: string): Promise<GateCounts> {
  const result = await pool.query<{
    rowsTotal: number;
    rowsInError: number;
    openBlocking: number;
    openErrors: number;
    reports: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM migration_rows WHERE batch_id = $1) AS "rowsTotal",
       (SELECT count(*)::int FROM migration_rows WHERE batch_id = $1 AND status = 'error') AS "rowsInError",
       (SELECT count(*)::int FROM migration_errors
         WHERE batch_id = $1 AND resolved_at IS NULL AND severity = 'blocking') AS "openBlocking",
       (SELECT count(*)::int FROM migration_errors
         WHERE batch_id = $1 AND resolved_at IS NULL AND severity = 'error') AS "openErrors",
       (SELECT count(*)::int FROM reconciliation_reports WHERE batch_id = $1) AS reports`,
    [batchId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('gate counts query returned no row');
  return {
    rowsTotal: row.rowsTotal,
    rowsInError: row.rowsInError,
    openFindings: { blocking: row.openBlocking, error: row.openErrors },
    reconciliationReports: row.reports
  };
}

/** Quantas linhas existem em cada status de `migration_rows`. */
export async function loadRowStatusCounts(pool: Pool, batchId: string): Promise<Record<string, number>> {
  const result = await pool.query<{ status: string; total: number }>(
    `SELECT status, count(*)::int AS total FROM migration_rows WHERE batch_id = $1 GROUP BY status`,
    [batchId]
  );
  return Object.fromEntries(result.rows.map((row) => [row.status, row.total]));
}

/** Achados por severidade, com quantos ja foram resolvidos. */
export async function loadFindingSummary(
  pool: Pool,
  batchId: string
): Promise<Record<string, { total: number; open: number }>> {
  const result = await pool.query<{ severity: string; total: number; open: number }>(
    `SELECT severity, count(*)::int AS total,
            count(*) FILTER (WHERE resolved_at IS NULL)::int AS open
       FROM migration_errors WHERE batch_id = $1 GROUP BY severity`,
    [batchId]
  );
  return Object.fromEntries(result.rows.map((row) => [row.severity, { total: row.total, open: row.open }]));
}

/**
 * Achados do lote para triagem.
 *
 * `resolved: true|false` filtra pelo `resolved_at`; ausente devolve os dois estados. `details` fica
 * fora da projecao de proposito: e o campo que carrega valor da planilha legada.
 */
export async function listFindings(
  pool: Pool,
  batchId: string,
  filters: { severity?: string; resolved?: boolean; limit: number }
): Promise<FindingListItem[]> {
  const result = await pool.query<FindingListItem>(
    `SELECT ${findingColumns('e.')}, r.source_sheet AS "sourceSheet", r.source_row_number AS "sourceRowNumber"
       FROM migration_errors e
       LEFT JOIN migration_rows r ON r.id = e.row_id
      WHERE e.batch_id = $1
        AND ($2 = '' OR e.severity = $2)
        AND ($3::boolean IS NULL OR (e.resolved_at IS NOT NULL) = $3::boolean)
      ORDER BY e.created_at, e.id
      LIMIT $4`,
    [batchId, filters.severity ?? '', filters.resolved ?? null, filters.limit]
  );
  return result.rows;
}

export async function loadReconciliationReports(
  pool: Pool,
  batchId: string
): Promise<ReconciliationRecord[]> {
  const result = await pool.query<ReconciliationRecord>(
    `SELECT entity_name AS "entityName", source_count AS "sourceCount", staged_count AS "stagedCount",
       canonical_count AS "canonicalCount", source_total AS "sourceTotal", canonical_total AS "canonicalTotal",
       duplicate_candidates AS "duplicateCandidates", blocking_errors AS "blockingErrors", notes,
       created_at AS "createdAt"
       FROM reconciliation_reports WHERE batch_id = $1 ORDER BY entity_name`,
    [batchId]
  );
  return result.rows;
}

/**
 * Marca um achado como resolvido e guarda a nota da triagem em `details.resolution`.
 *
 * Idempotente: repetir a resolucao devolve `already_resolved` com o `resolvedAt` original, sem
 * reescrever a nota nem mover a data.
 */
export async function resolveFinding(
  pool: Pool,
  id: string,
  note: string | undefined,
  actorId: string | null
): Promise<ResolveOutcome> {
  const updated = await pool.query<FindingRecord>(
    `UPDATE migration_errors
        SET resolved_at = now(),
            details = details || jsonb_strip_nulls(jsonb_build_object('resolution', $2::text, 'resolvedBy', $3::text))
      WHERE id = $1 AND resolved_at IS NULL
      RETURNING ${FINDING_COLUMNS}`,
    [id, note ?? null, actorId]
  );
  const resolved = updated.rows[0];
  if (resolved) return { status: 'resolved', finding: resolved };

  const existing = await pool.query<FindingRecord>(
    `SELECT ${FINDING_COLUMNS} FROM migration_errors WHERE id = $1`,
    [id]
  );
  const finding = existing.rows[0];
  return finding ? { status: 'already_resolved', finding } : { status: 'not_found' };
}

/**
 * Sela o lote no proximo status, exigindo que ele ainda esteja em um estado que aceita a transicao.
 *
 * O filtro de status vive no `WHERE` do `UPDATE`, entao duas requisicoes concorrentes nao selam o
 * mesmo lote duas vezes: a segunda nao encontra linha e o route responde 409.
 * `completed_at` so e tocado no `commit`, porque e ele que fecha a janela da carga.
 */
export async function sealBatch(
  pool: Pool,
  id: string,
  next: 'validated' | 'committed',
  from: readonly string[]
): Promise<BatchRecord | null> {
  const result = await pool.query<BatchRecord>(
    `UPDATE migration_batches
        SET status = $2,
            updated_at = now(),
            completed_at = CASE WHEN $2 = 'committed' THEN now() ELSE completed_at END
      WHERE id = $1 AND status = ANY($3::text[])
      RETURNING ${BATCH_COLUMNS}`,
    [id, next, [...from]]
  );
  return result.rows[0] ?? null;
}

