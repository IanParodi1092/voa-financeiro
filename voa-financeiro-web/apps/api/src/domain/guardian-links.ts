/**
 * Promocao assistida de responsavel (`guardians`) para cliente (`customers`).
 *
 * O que a carga deixou de proposito sem resolver: `guardians.customer_id` nasceu nulo e
 * `is_verified` falso (migration `0011`) porque **nome do legado nunca vira cliente**. Este modulo
 * nao muda essa decisao - ele so descreve, para a tela, o que a propria estrutura do dado ja diz:
 * o pagador dos acordos do aluno e um candidato, e o nome igual e a evidencia.
 *
 * Por que o universo de candidatos e o pagador e nao os 26.264 `customers`: 24.696 linhas vem de
 * `TBL_CLIENTE` e sao escolas/empresas (CNPJ), e 1.568 vem de `TBL_PAGAMENTO`, o pagador
 * sintetizado do acordo. Comparar o nome do responsavel com a tabela inteira produz ruido de
 * empresa ("ESCOLA BOSQUE EIRELI"), e por isso a lista de candidatos sai de
 * `agreements.customer_id` do **proprio aluno** - um vinculo estrutural, nao uma semelhanca.
 *
 * Medido no canonico local (2026-10-27, 6.347 guardioes): 274 com um unico candidato, 102 com duas
 * ou mais linhas de pagador do mesmo nome, 774 com pagador de outro nome, 5.197 sem acordo. As 102
 * "ambiguas" nao sao duvida de identidade: sao a mesma pessoa repetida em uma linha de pagador por
 * acordo do aluno. A escolha continua humana - o maximo que o modulo faz e ordenar por numero de
 * acordos para a linha mais representativa aparecer primeiro.
 */

export const GUARDIAN_LINK_STATUSES = ['single', 'ambiguous', 'no_match', 'no_payer', 'linked'] as const;

export type GuardianLinkStatus = (typeof GUARDIAN_LINK_STATUSES)[number];

/** Titulo de cada situacao, usado na resposta para a tela nao repetir o texto. */
export const GUARDIAN_LINK_TITLES: Record<GuardianLinkStatus, string> = {
  single: 'Um unico pagador do aluno tem o nome do responsavel',
  ambiguous: 'Mais de uma linha de pagador tem o nome do responsavel',
  no_match: 'O aluno tem pagador, mas nenhum com o nome do responsavel',
  no_payer: 'O aluno nao tem acordo com pagador',
  linked: 'Responsavel ja vinculado a um cliente'
};

export interface GuardianLinkCandidate {
  customerId: string;
  fullName: string;
  legacyTable: string | null;
  legacyId: string | null;
  /** Acordos do aluno pagos por esta linha de cliente. */
  agreements: number;
}

export interface GuardianLinkInput {
  /** `guardians.customer_id`: quando preenchido, o vinculo ja foi decidido. */
  linkedCustomerId: string | null;
  /** Linhas de cliente distintas que pagam acordos do aluno. */
  payers: number;
  /** Pagadores cujo nome bate com o do responsavel. */
  candidates: readonly GuardianLinkCandidate[];
}

/**
 * Situacao de um responsavel, na ordem em que as condicoes se sobrepoem.
 *
 * `linked` vem primeiro porque um vinculo confirmado nao e reinterpretado pela ausencia de
 * candidato (o operador pode ter corrigido o nome do cliente depois).
 */
export function classifyGuardianLink(input: GuardianLinkInput): GuardianLinkStatus {
  if (input.linkedCustomerId) return 'linked';
  const candidates = Array.isArray(input.candidates) ? input.candidates.length : 0;
  if (candidates === 1) return 'single';
  if (candidates > 1) return 'ambiguous';
  return Number(input.payers) > 0 ? 'no_match' : 'no_payer';
}

export function isGuardianLinkStatus(value: string): value is GuardianLinkStatus {
  return (GUARDIAN_LINK_STATUSES as readonly string[]).includes(value);
}

/**
 * Candidato sugerido, ou `null` quando a escolha nao e obvia.
 *
 * So devolve algo para `single` (um candidato) - em `ambiguous` a ordenacao por acordos ajuda a
 * tela, mas escolher por conta propria seria transformar um nome em vinculo, que e exatamente o que
 * a `0011` proibiu. A rota exige `customerId` explicito nesse caso.
 */
export function suggestCandidate(input: GuardianLinkInput): GuardianLinkCandidate | null {
  return classifyGuardianLink(input) === 'single' ? input.candidates[0] ?? null : null;
}

/** `offset` da listagem: inteiro nao negativo; lixo cai em 0 (mesmo criterio de `parseDetailLimit`). */
export function parseLinkOffset(raw: unknown, max = 100_000): number {
  const parsed = Number(raw ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.floor(parsed), max);
}
