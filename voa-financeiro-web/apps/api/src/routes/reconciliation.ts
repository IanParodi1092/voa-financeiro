import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { listGuardianCustomerLinkDivergences, loadGuardianCustomerLinkDivergence } from '../db/guardian-links.js';
import {
  listAgreementInstallmentDivergences,
  listAgreementTotalDivergences,
  listProvenanceGaps,
  listUnresolvedLegacyKeys,
  loadAgreementInstallmentDivergence,
  loadAgreementTotalDivergence,
  loadCoverage,
  loadProvenance,
  loadUnresolvedLegacyKeys
} from '../db/reconciliation-post-load.js';
import {
  CHECK_TITLES,
  RECONCILIATION_CHECKS,
  classify,
  isReconciliationCheck,
  parseDetailLimit,
  summarize,
  type CheckOutcome,
  type ReconciliationCheck
} from '../domain/reconciliation.js';
import type { RouteDeps } from '../http/deps.js';
import { requireAuthentication } from '../http/guards.js';

/**
 * Detalhe de cada verificacao do relatorio pos-corte, por chave.
 *
 * Um mapa em vez da cadeia de ternarios que existia: com a quinta verificacao a cadeia virava
 * aninhamento de tres niveis, e uma chave nova passa a ser um erro de tipo aqui (o `Record` e
 * exaustivo) em vez de cair no `else` e devolver o detalhe da verificacao errada.
 */
const RECONCILIATION_DETAILS: Record<
  ReconciliationCheck,
  (pool: Pool, limit: number) => Promise<unknown[]>
> = {
  legacy_provenance: listProvenanceGaps,
  legacy_key_resolves: listUnresolvedLegacyKeys,
  agreement_total: listAgreementTotalDivergences,
  agreement_installments: listAgreementInstallmentDivergences,
  guardian_customer_link: listGuardianCustomerLinkDivergences
};

/**
 * Conciliacao pos-corte (somente leitura).
 *
 * Confere o que ficou **gravado** depois da carga: proveniencia legada, chave legada resolvendo no
 * staging, as duas somas do acordo e o vinculo responsavel -> cliente. Nao corrige nada - a
 * correcao continua sendo uma rodada da carga (`--commit`) ou do backfill, com decisao explicita do
 * operador.
 *
 * `payments` e `users` ficam fora da proveniencia de proposito: o primeiro nao tem colunas
 * `legacy_*` (nasce da aplicacao e do webhook Asaas) e o segundo e criado por `auth:create-admin`.
 */
export function registerReconciliationRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { pool } = deps;

  app.get('/api/v1/reconciliation/post-load', { preHandler: requireAuthentication }, async (request, reply) => {
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const [provenance, unresolved, agreementTotal, agreementInstallments, guardianLinks, coverage] = await Promise.all([
      loadProvenance(pool),
      loadUnresolvedLegacyKeys(pool),
      loadAgreementTotalDivergence(pool),
      loadAgreementInstallmentDivergence(pool),
      loadGuardianCustomerLinkDivergence(pool),
      loadCoverage(pool)
    ]);
    const withoutProvenance = provenance.reduce((total, row) => total + row.withoutProvenance, 0);
    const unresolvedKeys = unresolved.reduce((total, row) => total + row.unresolvedLegacyKeys, 0);
    const outcomes = [
      { key: 'legacy_provenance', divergent: withoutProvenance },
      { key: 'legacy_key_resolves', divergent: unresolvedKeys },
      { key: 'agreement_total', divergent: agreementTotal.divergent },
      { key: 'agreement_installments', divergent: agreementInstallments },
      { key: 'guardian_customer_link', divergent: guardianLinks }
    ] satisfies CheckOutcome[];
    const summary = summarize(outcomes);
    const checks = [
      {
        key: 'legacy_provenance' as const,
        title: CHECK_TITLES.legacy_provenance,
        status: classify(withoutProvenance),
        divergent: withoutProvenance,
        entities: provenance
      },
      {
        key: 'legacy_key_resolves' as const,
        title: CHECK_TITLES.legacy_key_resolves,
        status: classify(unresolvedKeys),
        divergent: unresolvedKeys,
        entities: unresolved
      },
      {
        key: 'agreement_total' as const,
        title: CHECK_TITLES.agreement_total,
        status: classify(agreementTotal.divergent),
        divergent: agreementTotal.divergent,
        deltaAmount: agreementTotal.deltaAmount ?? '0.00'
      },
      {
        key: 'agreement_installments' as const,
        title: CHECK_TITLES.agreement_installments,
        status: classify(agreementInstallments),
        divergent: agreementInstallments
      },
      {
        key: 'guardian_customer_link' as const,
        title: CHECK_TITLES.guardian_customer_link,
        status: classify(guardianLinks),
        divergent: guardianLinks
      }
    ];
    return { generatedAt: new Date().toISOString(), ...summary, checks, coverage };
  });

  /**
   * Detalhe (paginado por `limit`, no maximo 200) das linhas que sobraram em uma verificacao.
   *
   * O detalhe e recalculado a cada chamada: nao ha snapshot guardado, entao o numero do detalhe
   * sempre concorda com o do relatorio no mesmo instante.
   */
  app.get('/api/v1/reconciliation/post-load/:check', { preHandler: requireAuthentication }, async (request, reply) => {
    const { check } = request.params as { check: string };
    if (!isReconciliationCheck(check)) {
      return reply.code(400).send({
        code: 'INVALID_REQUEST',
        message: `check must be one of ${RECONCILIATION_CHECKS.join(', ')}`,
        correlationId: request.id
      });
    }
    const limit = parseDetailLimit((request.query as { limit?: string }).limit);
    if (!pool) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', message: 'Database is temporarily unavailable', correlationId: request.id });
    const items = await RECONCILIATION_DETAILS[check](pool, limit);
    return { check, title: CHECK_TITLES[check], limit, items };
  });
}
