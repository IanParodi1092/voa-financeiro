import type { Pool } from 'pg';

/**
 * Outcome of a partial update, so the route can answer without inspecting `pg` errors.
 *
 * - `not_found`: the id does not exist **or** the row is soft-deleted;
 * - `conflict`: a unique constraint was hit (`23505`);
 * - `invalid_reference`: a foreign key does not exist (`23503`);
 * - `invalid_value`: a CHECK refused the value (`23514`): the request validation missed a rule the
 *   schema enforces, and the API answers 400 instead of leaking the SQL error.
 */
export type PatchOutcome =
  | { status: 'updated'; row: Record<string, unknown> }
  | { status: 'not_found' }
  | { status: 'conflict' }
  | { status: 'invalid_reference' }
  | { status: 'invalid_value' };

export interface PatchTarget {
  /** Table name. Always a literal declared by this code base, never a value from the request. */
  table: string;
  /** `RETURNING` projection, already aliased to the camelCase names of the API. */
  returning: string;
  /** Tables without `deleted_at` (`payments`) update every row they can find. */
  softDelete: boolean;
}

/**
 * Runs `UPDATE <table> SET <columns>, updated_at = now() WHERE id = $1 RETURNING ...`.
 *
 * `columns` maps a **trusted** column name to its new value: callers build it from the PATCH spec
 * allowlist, so nothing from the request body can reach the statement text, and every value is
 * bound as a parameter. `updated_at` is always refreshed; otherwise a change that touches only one
 * column would keep the old timestamp.
 */
export async function patchRow(
  pool: Pool,
  target: PatchTarget,
  id: string,
  columns: Record<string, unknown>
): Promise<PatchOutcome> {
  const entries = Object.entries(columns);
  if (entries.length === 0) throw new Error('patchRow needs at least one column');
  const assignments = entries.map(([column], index) => `${column} = $${index + 2}`);
  assignments.push('updated_at = now()');
  const where = target.softDelete ? 'id = $1 AND deleted_at IS NULL' : 'id = $1';
  try {
    const result = await pool.query(
      `UPDATE ${target.table} SET ${assignments.join(', ')} WHERE ${where} RETURNING ${target.returning}`,
      [id, ...entries.map(([, value]) => value)]
    );
    const row = result.rows[0];
    return row ? { status: 'updated', row: row as Record<string, unknown> } : { status: 'not_found' };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '23505') return { status: 'conflict' };
    if (code === '23503') return { status: 'invalid_reference' };
    if (code === '23514') return { status: 'invalid_value' };
    throw error;
  }
}
