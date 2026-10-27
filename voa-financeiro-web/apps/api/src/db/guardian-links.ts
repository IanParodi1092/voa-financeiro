import type { Pool } from 'pg';
import type { GuardianLinkCandidate, GuardianLinkStatus } from '../domain/guardian-links.js';

/**
 * Consultas da fila de promocao responsavel -> cliente.
 *
 * A normalizacao de nome roda **no banco** para o filtro, a contagem e a paginacao enxergarem a
 * mesma definicao de igualdade. Duas versoes da regra (uma no SQL, outra no TS) divergiriam na
 * primeira vez que alguem mexesse em uma delas.
 *
 * `lower()` aparece **depois** do `translate` porque o banco local roda em collation `C`: ali
 * `lower('É')` nao rebaixa nada. Ordem: `translate` (acento -> ASCII) -> `lower` (A-Z) -> colapsa
 * espacos -> `btrim`. As 24 minusculas e as 24 maiusculas acentuadas estao nas duas listas, e o
 * teste de integracao cobre `JOSÉ` e `  Maria   da  Silva `.
 */
const ACCENT_FROM = 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ';
const ACCENT_TO = 'aaaaaeeeeiiiiooooouuuucnaaaaaeeeeiiiiooooouuuucn';

const normalizedName = (column: string): string =>
  `btrim(regexp_replace(lower(translate(${column}, '${ACCENT_FROM}', '${ACCENT_TO}')), '\\s+', ' ', 'g'))`;

/**
 * Pagadores de cada aluno: uma linha de `agreements.customer_id` distinta por guardiao.
 *
 * O universo sai da estrutura (quem pagou acordo do aluno), nunca da tabela `customers` inteira -
 * 24.696 dos 26.264 clientes sao escolas/empresas de `TBL_CLIENTE`, e comparar nome de pessoa com
 * razao social so produz ruido.
 */
const payerCte = `
  WITH payer AS (
    SELECT g.id AS guardian_id, a.customer_id, count(DISTINCT a.id)::int AS agreements
      FROM guardians g
      JOIN agreements a
        ON a.student_id = g.student_id AND a.deleted_at IS NULL AND a.customer_id IS NOT NULL
     WHERE g.deleted_at IS NULL
     GROUP BY g.id, a.customer_id
  )`;

/**
 * Um guardiao por linha, com os pagadores do aluno ja classificados.
 *
 * `matching` conta os pagadores cujo nome normalizado bate com o do responsavel; `candidates`
 * carrega essas linhas (nome, chave legada e numero de acordos) para a tela decidir sem um segundo
 * request por item.
 */
const classifiedCte = `${payerCte},
  guardian_payers AS (
    SELECT g.id AS "guardianId", g.full_name AS "guardianName", g.student_id AS "studentId",
           s.full_name AS "studentName", g.customer_id AS "linkedCustomerId",
           count(p.customer_id)::int AS payers,
           count(p.customer_id) FILTER (
             WHERE ${normalizedName('c.full_name')} = ${normalizedName('g.full_name')}
           )::int AS matching,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'customerId', c.id,
                 'fullName', c.full_name,
                 'legacyTable', c.legacy_table,
                 'legacyId', c.legacy_id,
                 'agreements', p.agreements
               ) ORDER BY p.agreements DESC, c.legacy_id
             ) FILTER (WHERE ${normalizedName('c.full_name')} = ${normalizedName('g.full_name')}),
             '[]'::jsonb
           ) AS candidates
      FROM guardians g
      JOIN students s ON s.id = g.student_id
      LEFT JOIN payer p ON p.guardian_id = g.id
      LEFT JOIN customers c ON c.id = p.customer_id AND c.deleted_at IS NULL
     WHERE g.deleted_at IS NULL
     GROUP BY g.id, s.full_name
  ),
  classified AS (
    SELECT guardian_payers.*,
           CASE
             WHEN "linkedCustomerId" IS NOT NULL THEN 'linked'
             WHEN matching = 1 THEN 'single'
             WHEN matching > 1 THEN 'ambiguous'
             WHEN payers > 0 THEN 'no_match'
             ELSE 'no_payer'
           END AS status
      FROM guardian_payers
  )`;

/** Ordem da fila: o que o operador pode confirmar em um clique vem primeiro. */
const statusRank = `CASE status WHEN 'single' THEN 0 WHEN 'ambiguous' THEN 1 WHEN 'no_match' THEN 2
  WHEN 'no_payer' THEN 3 ELSE 4 END`;

export interface GuardianLinkQueueItem {
  guardianId: string;
  guardianName: string;
  studentId: string;
  studentName: string;
  linkedCustomerId: string | null;
  payers: number;
  status: GuardianLinkStatus;
  candidates: GuardianLinkCandidate[];
}


export interface GuardianLinkQueue {
  status?: GuardianLinkStatus;
  limit: number;
  offset: number;
  items: GuardianLinkQueueItem[];
  counts: Record<GuardianLinkStatus, number>;
}

/** Cobertura da fila por situacao - a mesma classificacao, sem paginacao. */
export async function loadGuardianLinkCounts(pool: Pool): Promise<Record<GuardianLinkStatus, number>> {
  const result = await pool.query<{ status: GuardianLinkStatus; total: number }>(
    `${classifiedCte}
     SELECT status, count(*)::int AS total FROM classified GROUP BY status`
  );
  const counts: Record<GuardianLinkStatus, number> = {
    single: 0,
    ambiguous: 0,
    no_match: 0,
    no_payer: 0,
    linked: 0
  };
  for (const row of result.rows) counts[row.status] = row.total;
  return counts;
}

/**
 * Fila paginada, opcionalmente presa a uma situacao.
 *
 * `status` chega ja validado pelo dominio (`isGuardianLinkStatus`); ainda assim vai como parametro
 * (`$1`), nunca interpolado no texto do SQL.
 */
export async function listGuardianLinkQueue(
  pool: Pool,
  options: { status?: GuardianLinkStatus; limit: number; offset: number }
): Promise<GuardianLinkQueueItem[]> {
  const result = await pool.query<GuardianLinkQueueItem>(
    `${classifiedCte}
     SELECT "guardianId", "guardianName", "studentId", "studentName", "linkedCustomerId",
            payers, status, candidates
       FROM classified
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY ${statusRank}, payers DESC, "guardianName", "guardianId"
      LIMIT $2 OFFSET $3`,
    [options.status ?? null, options.limit, options.offset]
  );
  return result.rows;
}

/**
 * Verificacao previa de um vinculo responsavel -> cliente.
 *
 * - `guardian_not_found`: id inexistente ou soft-deleted;
 * - `customer_not_found`: id inexistente ou soft-deleted;
 * - `customer_not_payer`: existe, mas nao paga nenhum acordo do aluno do guardiao. E a trava que
 *   impede promover um responsavel a uma das 24.696 escolas de `TBL_CLIENTE`.
 */
export type GuardianLinkCheck = 'ok' | 'guardian_not_found' | 'customer_not_found' | 'customer_not_payer';

/**
 * Responde se o par guardiao/cliente pode ser gravado.
 *
 * Existe separado da escrita porque o PATCH e generico: a rota chama isto antes de deixar o
 * `patchRow` tocar na tabela, e assim a regra vale para qualquer cliente da API (inclusive o
 * `viewer` que virar `admin` amanha) sem duplicar `UPDATE`.
 */
export async function checkGuardianCustomerLink(
  pool: Pool,
  guardianId: string,
  customerId: string
): Promise<GuardianLinkCheck> {
  const guardian = await pool.query<{ studentId: string }>(
    'SELECT student_id AS "studentId" FROM guardians WHERE id = $1 AND deleted_at IS NULL',
    [guardianId]
  );
  const studentId = guardian.rows[0]?.studentId;
  if (!studentId) return 'guardian_not_found';

  const customer = await pool.query('SELECT 1 FROM customers WHERE id = $1 AND deleted_at IS NULL', [
    customerId
  ]);
  if (customer.rowCount === 0) return 'customer_not_found';

  const pays = await pool.query(
    `SELECT 1 FROM agreements
      WHERE student_id = $1 AND customer_id = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [studentId, customerId]
  );
  return pays.rowCount === 0 ? 'customer_not_payer' : 'ok';
}


/**
 * Vinculos que nao se sustentam: guardiao apontando para cliente que nao paga acordo do aluno.
 *
 * E a quinta invariante do relatorio pos-corte. Hoje a coluna esta nula em 6.347 guardioes (a `0011`
 * nasceu assim) e o numero e 0; a consulta existe para a fila de promocao nao poder criar um vinculo
 * que o relatorio nao veria.
 */
export async function loadGuardianCustomerLinkDivergence(pool: Pool): Promise<number> {
  const result = await pool.query<{ divergent: number }>(
    `SELECT count(*)::int AS divergent
       FROM guardians g
      WHERE g.deleted_at IS NULL AND g.customer_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM agreements a
           WHERE a.student_id = g.student_id AND a.customer_id = g.customer_id AND a.deleted_at IS NULL)`
  );
  return result.rows[0]?.divergent ?? 0;
}

export interface GuardianLinkDivergenceItem {
  id: string;
  fullName: string;
  studentId: string;
  customerId: string;
  customerName: string | null;
  createdAt: Date;
}

/** Detalhe dos vinculos que nao se sustentam, mais recentes primeiro. */
export async function listGuardianCustomerLinkDivergences(
  pool: Pool,
  limit: number
): Promise<GuardianLinkDivergenceItem[]> {
  const result = await pool.query<GuardianLinkDivergenceItem>(
    `SELECT g.id, g.full_name AS "fullName", g.student_id AS "studentId",
            g.customer_id AS "customerId", c.full_name AS "customerName",
            g.created_at AS "createdAt"
       FROM guardians g
       LEFT JOIN customers c ON c.id = g.customer_id
      WHERE g.deleted_at IS NULL AND g.customer_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM agreements a
           WHERE a.student_id = g.student_id AND a.customer_id = g.customer_id AND a.deleted_at IS NULL)
      ORDER BY g.created_at DESC, g.id
      LIMIT $1`,
    [limit]
  );
  return result.rows;
}
