/**
 * Conciliacao pos-corte: as invariantes que o banco canonico tem de satisfazer depois de a revisao
 * do legado ser carregada.
 *
 * Cada verificacao responde "0 linhas divergentes ou nada" - nao existe limiar toleravel. O
 * `scripts/load_canonical_batch.py` conta o que carregou; isto confere o que **ficou gravado**, e
 * por isso pega o que uma carga seguinte (ou uma escrita da aplicacao) pode ter desalinhado.
 *
 * Fora do escopo, de proposito:
 * - `payments` nasce da aplicacao e do webhook Asaas e nao tem colunas `legacy_*` (migration `0004`
 *   + `0008`), entao nao ha proveniencia a conferir; a reconciliacao dele e por `external_id`,
 *   trabalho da integracao Asaas;
 * - `users` e criado por `auth:create-admin` (`TBL_USER.ID` esta `defer` no dicionario), ou seja,
 *   usuario sem `legacy_source` e o esperado, nao uma divergencia;
 * - `agreements.reference` nulo nao entra: e preenchimento (`--enrich-reused`), nao integridade.
 */

/**
 * Tabelas canonicas que carregam `legacy_source`/`legacy_table`/`legacy_id`.
 *
 * A lista e fixa (e nao lida de `information_schema`) para a consulta ser deterministica e para uma
 * tabela nova aparecer aqui por decisao, nao por acidente.
 */
export const PROVENANCE_TABLES = [
  'schools',
  'customers',
  'students',
  'guardians',
  'contacts',
  'student_contacts',
  'agreements',
  'installments'
] as const;

export type ProvenanceTable = (typeof PROVENANCE_TABLES)[number];

/**
 * De qual aba do workbook cada entidade canonica sai.
 *
 * `customers` aparece duas vezes na origem: `TBL_CLIENTE` (24.696 linhas) e o cliente pagador
 * sintetizado de `TBL_PAGAMENTO` (1.568), por isso o mapa e de lista e nao de par unico.
 * `TBL_ALUNO` alimenta `students` **e** `guardians` (uma linha de aluno, duas entidades).
 */
export const COVERAGE_MAP: readonly { entity: ProvenanceTable; legacyTables: readonly string[] }[] = [
  { entity: 'schools', legacyTables: ['TBL_ESCOLA'] },
  { entity: 'customers', legacyTables: ['TBL_CLIENTE', 'TBL_PAGAMENTO'] },
  { entity: 'students', legacyTables: ['TBL_ALUNO'] },
  { entity: 'guardians', legacyTables: ['TBL_ALUNO'] },
  { entity: 'contacts', legacyTables: ['TBL_CLIENTEENDTEL'] },
  { entity: 'student_contacts', legacyTables: ['TBL_ENDTEL'] },
  { entity: 'agreements', legacyTables: ['TBL_PAGAMENTO'] },
  { entity: 'installments', legacyTables: ['TBL_PAGAMENTO_LISTAGEM'] }
] as const;

export const RECONCILIATION_CHECKS = [
  'legacy_provenance',
  'legacy_key_resolves',
  'agreement_total',
  'agreement_installments',
  'guardian_customer_link'
] as const;

export type ReconciliationCheck = (typeof RECONCILIATION_CHECKS)[number];

/** Titulo de cada verificacao, usado na resposta para a tela nao repetir o texto. */
export const CHECK_TITLES: Record<ReconciliationCheck, string> = {
  legacy_provenance: 'Linhas canonicas sem proveniencia legada',
  legacy_key_resolves: 'Chave legada da linha canonica ausente no staging',
  agreement_total: 'Acordo com total diferente da soma das parcelas',
  agreement_installments: 'Acordo com installments_count diferente das parcelas gravadas',
  guardian_customer_link: 'Responsavel vinculado a cliente que nao paga acordo do aluno'
};

export type CheckStatus = 'ok' | 'divergent';

/**
 * Uma verificacao esta `ok` quando nao sobrou nenhuma linha divergente.
 *
 * O guarda de `Number.isFinite` existe porque as contagens vem do driver: um `null` inesperado nao
 * pode virar "tudo certo" por comparacao frouxa.
 */
export function classify(divergent: number): CheckStatus {
  return Number.isFinite(divergent) && divergent > 0 ? 'divergent' : 'ok';
}

export interface CheckOutcome {
  key: ReconciliationCheck;
  divergent: number;
}

/** Resumo do relatorio: `ok` so quando todas as verificacoes estao zeradas. */
export function summarize(outcomes: readonly CheckOutcome[]): { ok: boolean; divergent: number } {
  const divergent = outcomes.reduce((total, outcome) => total + Math.max(0, Number(outcome.divergent) || 0), 0);
  return { ok: divergent === 0, divergent };
}

export function isReconciliationCheck(value: string): value is ReconciliationCheck {
  return (RECONCILIATION_CHECKS as readonly string[]).includes(value);
}

/** Clamp do `limit` de detalhe, no mesmo formato das outras listagens (`GET /api/v1/...`). */
export function parseDetailLimit(raw: unknown, fallback = 50, max = 200): number {
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}
