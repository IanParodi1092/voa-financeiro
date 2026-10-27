import type { Pool } from 'pg';
import { COVERAGE_MAP, PROVENANCE_TABLES } from '../domain/reconciliation.js';

/**
 * Consultas da conciliacao pos-corte.
 *
 * Todas sao **somente leitura**: o relatorio confere o que a carga gravou e nunca corrige nada. A
 * unica escrita do fluxo continua sendo `scripts/load_canonical_batch.py` (com `--commit`) e o
 * `scripts/backfill_legacy_provenance.py` (com `--commit`), que exigem decisao explicita.
 *
 * Os nomes de tabela/aba interpolados no SQL vem de constantes do modulo de dominio - nunca do
 * request. `quoteList` recusa qualquer coisa que nao pareca um identificador do legado, para o
 * `IN (...)` nao virar ponto de injecao se alguem editar a lista no futuro.
 */

const quoteList = (values: readonly string[]): string =>
  values
    .map((value) => {
      if (!/^[A-Za-z0-9_]+$/u.test(value)) throw new Error(`unexpected identifier in coverage map: ${value}`);
      return `'${value}'`;
    })
    .join(', ');

const provenanceUnion = PROVENANCE_TABLES.map(
  (table) => `SELECT '${table}'::text AS entity, count(*)::int AS "totalRows",
          count(*) FILTER (WHERE t.legacy_source IS NULL)::int AS "withoutProvenance"
     FROM ${table} t`
).join('\nUNION ALL\n');

/**
 * `count(*) FILTER (WHERE NOT EXISTS ...)` seria a forma obvia, mas ela obriga o planner a avaliar
 * o subselect linha a linha e derruba a versao para ~1,3 s (medido nas 150.018 linhas locais). Com
 * o `NOT EXISTS` no `WHERE`, o Postgres monta um *hash anti join* com o indice
 * `migration_rows_legacy_idx` e o total cai para ~150 ms.
 */
const unresolvedUnion = PROVENANCE_TABLES.map(
  (table) => `SELECT '${table}'::text AS entity,
          (SELECT count(*) FROM ${table})::int AS "totalRows",
          count(*)::int AS "unresolvedLegacyKeys"
     FROM ${table} t
    WHERE t.legacy_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM migration_rows r
         WHERE r.legacy_table = t.legacy_table AND r.legacy_id = t.legacy_id)`
).join('\nUNION ALL\n');

const coverageCanonicalUnion = COVERAGE_MAP.map(
  (mapping) => `SELECT '${mapping.entity}'::text AS entity, count(*)::int AS "canonicalRows" FROM ${mapping.entity}`
).join('\nUNION ALL\n');

const coverageStagedUnion = COVERAGE_MAP.map(
  (mapping) => `SELECT '${mapping.entity}'::text AS entity, count(*)::int AS "stagedRows"
     FROM migration_rows WHERE legacy_table IN (${quoteList(mapping.legacyTables)})`
).join('\nUNION ALL\n');

const coveragePendingUnion = COVERAGE_MAP.map(
  (mapping) => `SELECT '${mapping.entity}'::text AS entity, count(*)::int AS "pendingCanonicalKeys"
     FROM migration_rows r
    WHERE r.legacy_table IN (${quoteList(mapping.legacyTables)}) AND r.legacy_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM ${mapping.entity} c
         WHERE c.legacy_table = r.legacy_table AND c.legacy_id = r.legacy_id)`
).join('\nUNION ALL\n');

export interface EntityProvenance {
  entity: string;
  totalRows: number;
  withoutProvenance: number;
}

export interface EntityUnresolvedKeys {
  entity: string;
  totalRows: number;
  unresolvedLegacyKeys: number;
}

export interface AgreementTotalDivergence {
  divergent: number;
  deltaAmount: string | null;
}

export interface ProvenanceGapItem {
  entity: string;
  id: string;
  createdAt: Date;
}

export interface UnresolvedKeyItem extends ProvenanceGapItem {
  legacyTable: string | null;
  legacyId: string | null;
}

export interface AgreementTotalItem {
  id: string;
  reference: string | null;
  totalAmount: string;
  installmentsTotal: string;
  delta: string;
  installments: number;
  createdAt: Date;
}

export interface AgreementInstallmentsItem {
  id: string;
  reference: string | null;
  installmentsCount: number;
  installments: number;
  createdAt: Date;
}

export interface CoverageRecord {
  entity: string;
  legacyTables: readonly string[];
  canonicalRows: number;
  stagedRows: number;
  pendingCanonicalKeys: number;
}

/** Ordena pelo `PROVENANCE_TABLES`/`COVERAGE_MAP` para a resposta nao mudar de ordem entre chamadas. */
const byDeclaredOrder = (order: readonly string[]) => (a: { entity: string }, b: { entity: string }) =>
  order.indexOf(a.entity) - order.indexOf(b.entity);

/** Linhas canonicas sem `legacy_source`, por entidade (a soma e o que a verificacao cobra). */
export async function loadProvenance(pool: Pool): Promise<EntityProvenance[]> {
  const result = await pool.query<EntityProvenance>(provenanceUnion);
  return result.rows.sort(byDeclaredOrder(PROVENANCE_TABLES));
}

/**
 * Linhas canonicas cuja chave `(legacy_table, legacy_id)` nao existe em `migration_rows`.
 *
 * Depois de `backfill_legacy_provenance.py --commit` isto tem de ser zero: qualquer linha aqui e
 * proveniencia carimbada errado (ou staging limpo com o canonico mantido).
 */
export async function loadUnresolvedLegacyKeys(pool: Pool): Promise<EntityUnresolvedKeys[]> {
  const result = await pool.query<EntityUnresolvedKeys>(unresolvedUnion);
  return result.rows.sort(byDeclaredOrder(PROVENANCE_TABLES));
}


/**
 * Acordos em que `total_amount` difere da soma de `installments.original_amount`.
 *
 * A tolerancia e de meio centavo (`0.005`) porque as duas colunas sao `numeric(16,2)`: diferenca
 * menor que isso nao existe em reais, e comparar float direto acusaria ruido de arredondamento.
 */
export async function loadAgreementTotalDivergence(pool: Pool): Promise<AgreementTotalDivergence> {
  const result = await pool.query<AgreementTotalDivergence>(
    `WITH per_agreement AS (
       SELECT a.id, a.total_amount, COALESCE(sum(i.original_amount), 0) AS installments_total
         FROM agreements a
         LEFT JOIN installments i ON i.agreement_id = a.id AND i.deleted_at IS NULL
        WHERE a.deleted_at IS NULL
        GROUP BY a.id, a.total_amount
     )
     SELECT count(*)::int AS divergent,
            COALESCE(sum(installments_total - total_amount), 0)::numeric(16, 2)::text AS "deltaAmount"
       FROM per_agreement
      WHERE abs(installments_total - total_amount) > 0.005`
  );
  return result.rows[0] ?? { divergent: 0, deltaAmount: '0.00' };
}

/** Acordos em que `installments_count` difere do numero de parcelas gravadas. */
export async function loadAgreementInstallmentDivergence(pool: Pool): Promise<number> {
  const result = await pool.query<{ divergent: number }>(
    `WITH per_agreement AS (
       SELECT a.installments_count, count(i.id) AS actual
         FROM agreements a
         LEFT JOIN installments i ON i.agreement_id = a.id AND i.deleted_at IS NULL
        WHERE a.deleted_at IS NULL
        GROUP BY a.id, a.installments_count
     )
     SELECT count(*)::int AS divergent FROM per_agreement WHERE actual <> installments_count`
  );
  return result.rows[0]?.divergent ?? 0;
}

/**
 * Cobertura por entidade: quantas linhas existem no canonico, quantas foram estagiadas e quantas
 * chaves estagiadas ainda nao tem linha canonica.
 *
 * `pendingCanonicalKeys` **nao e divergencia**: o dicionario descarta linhas de proposito (`ignore`)
 * e adia campos (`defer`), entao o numero e informativo e serve para comparar rodadas.
 */
export async function loadCoverage(pool: Pool): Promise<CoverageRecord[]> {
  const [canonical, staged, pending] = await Promise.all([
    pool.query<{ entity: string; canonicalRows: number }>(coverageCanonicalUnion),
    pool.query<{ entity: string; stagedRows: number }>(coverageStagedUnion),
    pool.query<{ entity: string; pendingCanonicalKeys: number }>(coveragePendingUnion)
  ]);
  const canonicalByEntity = new Map(canonical.rows.map((row) => [row.entity, row.canonicalRows]));
  const stagedByEntity = new Map(staged.rows.map((row) => [row.entity, row.stagedRows]));
  const pendingByEntity = new Map(pending.rows.map((row) => [row.entity, row.pendingCanonicalKeys]));
  return COVERAGE_MAP.map((mapping) => ({
    entity: mapping.entity,
    legacyTables: mapping.legacyTables,
    canonicalRows: canonicalByEntity.get(mapping.entity) ?? 0,
    stagedRows: stagedByEntity.get(mapping.entity) ?? 0,
    pendingCanonicalKeys: pendingByEntity.get(mapping.entity) ?? 0
  }));
}

/** Detalhe das linhas sem proveniencia, mais recentes primeiro. */
export async function listProvenanceGaps(pool: Pool, limit: number): Promise<ProvenanceGapItem[]> {
  const union = PROVENANCE_TABLES.map(
    (table) => `SELECT '${table}'::text AS entity, t.id, t.created_at AS "createdAt"
       FROM ${table} t WHERE t.legacy_source IS NULL`
  ).join('\nUNION ALL\n');
  const result = await pool.query<ProvenanceGapItem>(
    `SELECT * FROM (${union}) gap ORDER BY "createdAt" DESC, entity, id LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/** Detalhe das chaves legadas que nao resolvem no staging, mais recentes primeiro. */
export async function listUnresolvedLegacyKeys(pool: Pool, limit: number): Promise<UnresolvedKeyItem[]> {
  const union = PROVENANCE_TABLES.map(
    (table) => `SELECT '${table}'::text AS entity, t.id, t.legacy_table AS "legacyTable",
          t.legacy_id AS "legacyId", t.created_at AS "createdAt"
       FROM ${table} t
      WHERE t.legacy_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM migration_rows r
         WHERE r.legacy_table = t.legacy_table AND r.legacy_id = t.legacy_id)`
  ).join('\nUNION ALL\n');
  const result = await pool.query<UnresolvedKeyItem>(
    `SELECT * FROM (${union}) gap ORDER BY "createdAt" DESC, entity, id LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/** Detalhe dos acordos com total divergente, maior diferenca primeiro. */
export async function listAgreementTotalDivergences(pool: Pool, limit: number): Promise<AgreementTotalItem[]> {
  const result = await pool.query<AgreementTotalItem>(
    `SELECT a.id, a.reference, a.total_amount::text AS "totalAmount",
            COALESCE(sum(i.original_amount), 0)::numeric(16, 2)::text AS "installmentsTotal",
            (COALESCE(sum(i.original_amount), 0) - a.total_amount)::numeric(16, 2)::text AS delta,
            count(i.id)::int AS installments, a.created_at AS "createdAt"
       FROM agreements a
       LEFT JOIN installments i ON i.agreement_id = a.id AND i.deleted_at IS NULL
      WHERE a.deleted_at IS NULL
      GROUP BY a.id, a.reference, a.total_amount
     HAVING abs(COALESCE(sum(i.original_amount), 0) - a.total_amount) > 0.005
      ORDER BY abs(COALESCE(sum(i.original_amount), 0) - a.total_amount) DESC, a.created_at DESC
      LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/** Detalhe dos acordos com `installments_count` divergente. */
export async function listAgreementInstallmentDivergences(
  pool: Pool,
  limit: number
): Promise<AgreementInstallmentsItem[]> {
  const result = await pool.query<AgreementInstallmentsItem>(
    `SELECT a.id, a.reference, a.installments_count AS "installmentsCount",
            count(i.id)::int AS installments, a.created_at AS "createdAt"
       FROM agreements a
       LEFT JOIN installments i ON i.agreement_id = a.id AND i.deleted_at IS NULL
      WHERE a.deleted_at IS NULL
      GROUP BY a.id, a.reference, a.installments_count
     HAVING count(i.id) <> a.installments_count
      ORDER BY a.created_at DESC, a.id
      LIMIT $1`,
    [limit]
  );
  return result.rows;
}

