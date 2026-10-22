import { z } from 'zod';

/**
 * Ciclo de vida de um lote de migracao, espelhando o CHECK de `migration_batches.status`
 * (`apps/api/migrations/0006_migration_staging.sql`).
 */
export const BATCH_STATUSES = [
  'profiled',
  'staging',
  'validated',
  'approved',
  'committed',
  'rolled_back',
  'failed'
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/**
 * Lotes que ainda podem ser selados como `validated`. `committed`, `rolled_back` e `failed` sao
 * estados finais: o gate nao reabre um lote que ja foi carregado ou descartado.
 */
export const VALIDATABLE_STATUSES = ['profiled', 'staging', 'validated', 'approved'] as const;

/**
 * Lotes que a carga canonica pode consumir. `profiled` e `staging` ainda nao passaram pelo
 * validador; `validated` e `approved` sao os unicos estados que a carga aceita.
 */
export const COMMITTABLE_STATUSES = ['validated', 'approved'] as const;

/** Contagens que o gate olha, todas lidas do staging do lote. */
export interface GateCounts {
  rowsTotal: number;
  rowsInError: number;
  openFindings: { blocking: number; error: number };
  reconciliationReports: number;
}

export const GATE_BLOCKERS = [
  'NO_ROWS',
  'ROWS_IN_ERROR',
  'OPEN_BLOCKING_FINDINGS',
  'OPEN_ERROR_FINDINGS',
  'NO_RECONCILIATION'
] as const;
export type GateBlocker = (typeof GATE_BLOCKERS)[number];

export type GateStage = 'validate' | 'commit';

export interface GateVerdict {
  ok: boolean;
  blockers: GateBlocker[];
}

/**
 * Recalcula o gate sobre o que **ja esta gravado** no staging: nao reexecuta o validador
 * (`npm run db:validate-staging`), so confere os achados e as contagens que ele deixou no banco.
 *
 * `validate` recusa lote vazio, linha marcada `error` e achado de severidade `blocking` ou `error`
 * ainda aberto (`resolved_at IS NULL`); `warning` nao bloqueia, porque o validador tambem nao marca
 * a linha nesse caso. `commit` acrescenta `NO_RECONCILIATION`: sem `reconciliation_reports` nao ha
 * prova de que as contagens do workbook foram conferidas antes da carga.
 */
export function evaluateGate(counts: GateCounts, stage: GateStage): GateVerdict {
  const blockers: GateBlocker[] = [];
  if (counts.rowsTotal <= 0) blockers.push('NO_ROWS');
  if (counts.rowsInError > 0) blockers.push('ROWS_IN_ERROR');
  if (counts.openFindings.blocking > 0) blockers.push('OPEN_BLOCKING_FINDINGS');
  if (counts.openFindings.error > 0) blockers.push('OPEN_ERROR_FINDINGS');
  if (stage === 'commit' && counts.reconciliationReports <= 0) blockers.push('NO_RECONCILIATION');
  return { ok: blockers.length === 0, blockers };
}

export function canValidate(status: BatchStatus): boolean {
  return (VALIDATABLE_STATUSES as readonly string[]).includes(status);
}

export function canCommit(status: BatchStatus): boolean {
  return (COMMITTABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * Registro de uma fonte no staging.
 *
 * `sourceHash` e o sha256 hexadecimal do arquivo (mesma chave de idempotencia do
 * `scripts/stage_legacy_workbook.py`): registrar duas vezes o mesmo arquivo devolve o lote
 * existente em vez de criar outro. `sourceKind` segue o CHECK de `migration_batches.source_kind`.
 */
export const registerBatchSchema = z.object({
  sourceName: z.string().trim().min(1).max(300),
  sourceHash: z.string().trim().regex(/^[0-9a-f]{64}$/u, 'sourceHash must be a sha256 hex digest'),
  sourceKind: z.enum(['xlsx', 'csv', 'xml', 'dataverse_export', 'other']).default('xlsx'),
  rowCount: z.number().int().nonnegative().max(50_000_000).default(0)
}).strict();

export type RegisterBatchInput = z.infer<typeof registerBatchSchema>;

/**
 * Triagem de um achado. A nota e opcional e vai para `migration_errors.details.resolution`, junto
 * com o id de quem resolveu; `resolved_at` e o que o gate consulta.
 */
export const resolveFindingSchema = z.object({
  note: z.string().trim().min(1).max(1000).optional()
}).strict();

export type ResolveFindingInput = z.infer<typeof resolveFindingSchema>;
