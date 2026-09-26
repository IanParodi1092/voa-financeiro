import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply every `*.sql` file of `migrationsDirectory` in name order, inside its own transaction.
 *
 * `schema_migrations` records what already ran, so a second call is a no-op. The runner is
 * extracted from `db/migrate.ts` so the integration tests can build a disposable schema with the
 * exact same migrations the production database uses.
 */
export async function applyMigrations(pool: Pool, migrationsDirectory: string): Promise<MigrationResult> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
  );
  const applied = new Set(
    (
      await pool.query<{ version: string }>('SELECT version FROM schema_migrations')
    ).rows.map((row) => row.version)
  );
  const result: MigrationResult = { applied: [], skipped: [] };
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) {
      result.skipped.push(file);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(resolve(migrationsDirectory, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      result.applied.push(file);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return result;
}
