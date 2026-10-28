import { describe, expect, it } from 'vitest';
import {
  ASAAS_EVENT_RULES,
  INSTALLMENT_STATUSES,
  PAYMENT_STATUSES,
  isMappedEvent,
  normalizeChargeStatus,
  resolveTransition
} from './asaas-events.js';

/**
 * A tabela da secao 3 do `docs/ASAAS_EVENT_RULES.md` em teste: o que cada evento faz, o que e `stale`
 * e o que nunca pode acontecer (evento desconhecido matando a fila, estorno sendo reaberto por um
 * evento atrasado).
 */

describe('mapa evento -> estado', () => {
  it('confirma pagamento e cria o lancamento como confirmed', () => {
    expect(resolveTransition('PAYMENT_CONFIRMED', 'pending')).toEqual({
      outcome: 'applied',
      from: 'pending',
      to: 'paid',
      paymentStatus: 'confirmed'
    });
  });

  it('recebimento sobe o lancamento de confirmed para paid sem mexer no estado da parcela', () => {
    expect(resolveTransition('PAYMENT_RECEIVED', 'paid')).toEqual({
      outcome: 'applied',
      from: 'paid',
      to: 'paid',
      paymentStatus: 'paid'
    });
  });

  it('recusa evento que reabriria parcela ja estornada', () => {
    expect(resolveTransition('PAYMENT_RECEIVED', 'refunded')).toMatchObject({
      outcome: 'stale',
      from: 'refunded',
      reason: 'PAYMENT_RECEIVED nao se aplica a refunded'
    });
  });

  it('nao cancela nem estorna parcela paga', () => {
    expect(resolveTransition('PAYMENT_DELETED', 'paid')).toMatchObject({ outcome: 'stale' });
    expect(resolveTransition('PAYMENT_REFUNDED', 'pending')).toMatchObject({ outcome: 'stale' });
  });

  it('permite o ciclo overdue -> canceled -> restored', () => {
    expect(resolveTransition('PAYMENT_OVERDUE', 'pending')).toMatchObject({ to: 'overdue' });
    expect(resolveTransition('PAYMENT_DELETED', 'overdue')).toMatchObject({ to: 'canceled' });
    expect(resolveTransition('PAYMENT_RESTORED', 'canceled')).toMatchObject({ to: 'pending' });
    expect(resolveTransition('PAYMENT_RESTORED', 'pending')).toMatchObject({ outcome: 'stale' });
  });

  it('estorno parcial mantem a parcela paga e marca o pagamento', () => {
    expect(resolveTransition('PAYMENT_PARTIALLY_REFUNDED', 'paid')).toEqual({
      outcome: 'applied',
      from: 'paid',
      to: 'paid',
      paymentStatus: 'partially_refunded'
    });
  });

  it('chargeback exige dinheiro recebido e aceita volta para pago quando a disputa e ganha', () => {
    expect(resolveTransition('PAYMENT_CHARGEBACK_REQUESTED', 'paid')).toMatchObject({ to: 'chargeback' });
    expect(resolveTransition('PAYMENT_CHARGEBACK_DISPUTE', 'refunded')).toMatchObject({ to: 'chargeback' });
    expect(resolveTransition('PAYMENT_AWAITING_CHARGEBACK_REVERSAL', 'paid')).toMatchObject({ to: 'chargeback' });
    expect(resolveTransition('PAYMENT_CHARGEBACK_REQUESTED', 'pending')).toMatchObject({ outcome: 'stale' });
    expect(resolveTransition('PAYMENT_RECEIVED', 'chargeback')).toMatchObject({ to: 'paid' });
  });

  it('evento fora do mapa e ignored, nunca dead', () => {
    expect(resolveTransition('PAYMENT_BANK_SLIP_VIEWED', 'pending')).toEqual({
      outcome: 'ignored',
      reason: 'evento fora do mapa: PAYMENT_BANK_SLIP_VIEWED'
    });
    expect(resolveTransition('EVENTO_QUE_NAO_EXISTE', 'pending')).toMatchObject({ outcome: 'ignored' });
    expect(isMappedEvent('PAYMENT_BANK_SLIP_VIEWED')).toBe(false);
    expect(isMappedEvent('payment_received')).toBe(true);
  });

  it('normaliza caixa e espaco do nome do evento', () => {
    expect(resolveTransition('  payment_received  ', 'pending')).toMatchObject({ outcome: 'applied', paymentStatus: 'paid' });
  });

  it('status fora do vocabulario vira stale em vez de ser sobrescrito', () => {
    expect(resolveTransition('PAYMENT_RECEIVED', 'pago_legado')).toMatchObject({
      outcome: 'stale',
      from: 'pago_legado'
    });
  });
});

describe('mapa declarado', () => {
  it('so aponta para estados do vocabulario fechado', () => {
    for (const rule of Object.values(ASAAS_EVENT_RULES)) {
      if (rule.status !== null) expect(INSTALLMENT_STATUSES).toContain(rule.status);
      if (rule.paymentStatus !== null) expect(PAYMENT_STATUSES).toContain(rule.paymentStatus);
      expect(rule.origins.length).toBeGreaterThan(0);
      for (const origin of rule.origins) expect(INSTALLMENT_STATUSES).toContain(origin);
    }
  });

  it('nao mapeia o mesmo evento duas vezes com regras diferentes', () => {
    const names = Object.keys(ASAAS_EVENT_RULES);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name === name.toUpperCase())).toBe(true);
  });
});

describe('status da cobranca no provedor', () => {
  it('normaliza para maiusculas e descarta valor invalido', () => {
    expect(normalizeChargeStatus(' received ')).toBe('RECEIVED');
    expect(normalizeChargeStatus('')).toBeNull();
    expect(normalizeChargeStatus('   ')).toBeNull();
    expect(normalizeChargeStatus(undefined)).toBeNull();
    expect(normalizeChargeStatus(42)).toBeNull();
    expect(normalizeChargeStatus('x'.repeat(41))).toBeNull();
  });
});
