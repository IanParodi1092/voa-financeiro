/**
 * Regras puras do consumidor de `asaas_events` (`docs/ASAAS_EVENT_RULES.md`).
 *
 * O provedor entrega **at least once** e, no modo `NON_SEQUENTIALLY`, fora de ordem. Em vez de
 * confiar na ordem, cada evento declara o estado alvo e as **origens aceitas**: um
 * `PAYMENT_RECEIVED` que chega atrasado depois de um estorno encontra `refunded` fora da lista e vira
 * `stale` (no-op auditado) em vez de reabrir uma parcela estornada.
 *
 * Nada aqui toca banco: o mapa e a decisao vivem neste modulo, e o teste unitario fixa a tabela.
 */

/** Estados que o consumidor escreve em `installments.status` (secao 2 do documento). */
export const INSTALLMENT_STATUSES = ['pending', 'overdue', 'paid', 'refunded', 'chargeback', 'canceled'] as const;

export type InstallmentStatus = (typeof INSTALLMENT_STATUSES)[number];

/** Estados que o consumidor escreve em `payments.status`. */
export const PAYMENT_STATUSES = ['pending', 'confirmed', 'paid', 'partially_refunded', 'refunded'] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** O que um evento faz com a parcela e com o lancamento em `payments`. */
export interface EventRule {
  /** Estado alvo da parcela; `null` quando o evento nao mexe nela. */
  status: InstallmentStatus | null;
  /** Estado alvo do pagamento; `null` quando o evento nao cria nem atualiza `payments`. */
  paymentStatus: PaymentStatus | null;
  /** Estados de origem aceitos. Fora da lista o evento e `stale`. */
  origins: readonly InstallmentStatus[];
}

/**
 * Tabela da secao 3 do documento, em codigo. Evento ausente do mapa e `ignored` - nunca `dead`: o
 * provedor adiciona eventos novos, e um evento desconhecido nao pode parar a fila.
 */
export const ASAAS_EVENT_RULES: Readonly<Record<string, EventRule>> = {
  PAYMENT_CONFIRMED: { status: 'paid', paymentStatus: 'confirmed', origins: ['pending', 'overdue', 'chargeback'] },
  PAYMENT_RECEIVED: { status: 'paid', paymentStatus: 'paid', origins: ['pending', 'overdue', 'paid', 'chargeback'] },
  PAYMENT_RECEIVED_IN_CASH: { status: 'paid', paymentStatus: 'paid', origins: ['pending', 'overdue'] },
  PAYMENT_OVERDUE: { status: 'overdue', paymentStatus: null, origins: ['pending', 'overdue'] },
  PAYMENT_DELETED: { status: 'canceled', paymentStatus: null, origins: ['pending', 'overdue'] },
  PAYMENT_RESTORED: { status: 'pending', paymentStatus: null, origins: ['canceled'] },
  PAYMENT_REFUNDED: { status: 'refunded', paymentStatus: 'refunded', origins: ['paid'] },
  PAYMENT_PARTIALLY_REFUNDED: { status: 'paid', paymentStatus: 'partially_refunded', origins: ['paid'] },
  PAYMENT_CHARGEBACK_REQUESTED: { status: 'chargeback', paymentStatus: null, origins: ['paid', 'refunded'] },
  PAYMENT_CHARGEBACK_DISPUTE: { status: 'chargeback', paymentStatus: null, origins: ['paid', 'refunded'] },
  PAYMENT_AWAITING_CHARGEBACK_REVERSAL: { status: 'chargeback', paymentStatus: null, origins: ['paid', 'refunded'] }
};

export type TransitionOutcome =
  | {
      outcome: 'applied';
      /** Estado da parcela antes do evento (pode ser um valor fora do vocabulario). */
      from: string;
      /** Estado depois; igual a `from` quando o evento so mexe em `payments`. */
      to: string;
      /** `null` = evento nao cria/atualiza pagamento. */
      paymentStatus: PaymentStatus | null;
    }
  | { outcome: 'stale'; from: string; to: InstallmentStatus; reason: string }
  | { outcome: 'ignored'; reason: string };

/**
 * Decide o que fazer com um evento, dado o estado atual da parcela.
 *
 * A comparacao e com o valor **cru** do banco, de proposito: um `installments.status` fora do
 * vocabulario (linha antiga, PATCH manual) nao entra em nenhuma lista de origem e o evento vira
 * `stale`, o que aparece no log em vez de sobrescrever um estado que ninguem entende.
 */
export function resolveTransition(eventType: string, currentStatus: string): TransitionOutcome {
  const normalized = eventType.trim().toUpperCase();
  const rule = ASAAS_EVENT_RULES[normalized];
  if (!rule) return { outcome: 'ignored', reason: `evento fora do mapa: ${normalized}` };
  if (!rule.origins.includes(currentStatus as InstallmentStatus)) {
    return {
      outcome: 'stale',
      from: currentStatus,
      to: rule.status ?? (currentStatus as InstallmentStatus),
      reason: `${normalized} nao se aplica a ${currentStatus}`
    };
  }
  return {
    outcome: 'applied',
    from: currentStatus,
    to: rule.status ?? currentStatus,
    paymentStatus: rule.paymentStatus
  };
}

export function isMappedEvent(eventType: string): boolean {
  return ASAAS_EVENT_RULES[eventType.trim().toUpperCase()] !== undefined;
}

/**
 * `asaas_charges.status` e texto livre e recebe o status do provedor (`PENDING`, `RECEIVED`...).
 * Devolve `null` para valor ausente/invalido, para o handler nao sobrescrever com string vazia.
 */
export function normalizeChargeStatus(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (normalized.length === 0 || normalized.length > 40) return null;
  return normalized;
}
