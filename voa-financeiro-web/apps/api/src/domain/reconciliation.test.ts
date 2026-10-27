import { describe, expect, it } from 'vitest';
import {
  CHECK_TITLES,
  COVERAGE_MAP,
  PROVENANCE_TABLES,
  RECONCILIATION_CHECKS,
  classify,
  isReconciliationCheck,
  parseDetailLimit,
  summarize
} from './reconciliation.js';

describe('veredito das verificacoes', () => {
  it('so fica ok com zero linhas divergentes', () => {
    expect(classify(0)).toBe('ok');
    expect(classify(1)).toBe('divergent');
    expect(classify(25)).toBe('divergent');
  });

  it('nao trata contagem invalida como sucesso nem como divergencia inventada', () => {
    expect(classify(Number.NaN)).toBe('ok');
    expect(classify(-4)).toBe('ok');
  });

  it('resume o relatorio somando as divergencias', () => {
    expect(summarize([])).toEqual({ ok: true, divergent: 0 });
    expect(
      summarize([
        { key: 'legacy_provenance', divergent: 0 },
        { key: 'agreement_total', divergent: 0 }
      ])
    ).toEqual({ ok: true, divergent: 0 });
    expect(
      summarize([
        { key: 'legacy_provenance', divergent: 3 },
        { key: 'legacy_key_resolves', divergent: 0 },
        { key: 'agreement_total', divergent: 1 },
        { key: 'agreement_installments', divergent: 2 }
      ])
    ).toEqual({ ok: false, divergent: 6 });
  });

  it('ignora numero invalido no resumo em vez de virar NaN', () => {
    expect(summarize([{ key: 'legacy_provenance', divergent: Number.NaN }])).toEqual({ ok: true, divergent: 0 });
  });
});

describe('limite do detalhe', () => {
  it('usa o padrao quando o valor falta ou nao e positivo', () => {
    expect(parseDetailLimit(undefined)).toBe(50);
    expect(parseDetailLimit('')).toBe(50);
    expect(parseDetailLimit('abc')).toBe(50);
    expect(parseDetailLimit('0')).toBe(50);
    expect(parseDetailLimit('-3')).toBe(50);
  });

  it('trunca no teto e corta a fracao', () => {
    expect(parseDetailLimit('7')).toBe(7);
    expect(parseDetailLimit('2.9')).toBe(2);
    expect(parseDetailLimit('500')).toBe(200);
    expect(parseDetailLimit('500', 50, 20)).toBe(20);
  });
});

describe('catalogo de verificacoes', () => {
  it('reconhece apenas as chaves declaradas', () => {
    for (const check of RECONCILIATION_CHECKS) {
      expect(isReconciliationCheck(check)).toBe(true);
    }
    expect(isReconciliationCheck('agreement_total ')).toBe(false);
    expect(isReconciliationCheck('payment_drift')).toBe(false);
    expect(isReconciliationCheck('')).toBe(false);
  });

  it('tem titulo para cada verificacao, sem chave sobrando no mapa', () => {
    expect(Object.keys(CHECK_TITLES).sort()).toEqual([...RECONCILIATION_CHECKS].sort());
  });
});

describe('mapa de cobertura', () => {
  it('cobre cada tabela canonica com proveniencia exatamente uma vez', () => {
    expect(COVERAGE_MAP.map((entry) => entry.entity).sort()).toEqual([...PROVENANCE_TABLES].sort());
    expect(new Set(COVERAGE_MAP.map((entry) => entry.entity)).size).toBe(COVERAGE_MAP.length);
  });

  it('aponta para abas do legado e nao para tabelas canonicas', () => {
    for (const entry of COVERAGE_MAP) {
      expect(entry.legacyTables.length).toBeGreaterThan(0);
      for (const legacyTable of entry.legacyTables) {
        expect(legacyTable).toMatch(/^TBL_[A-Z0-9_]+$/u);
      }
    }
  });

  it('mantem as duas origens de customers e as duas entidades de TBL_ALUNO', () => {
    const customers = COVERAGE_MAP.find((entry) => entry.entity === 'customers');
    expect(customers?.legacyTables).toEqual(['TBL_CLIENTE', 'TBL_PAGAMENTO']);
    const fromStudents = COVERAGE_MAP.filter((entry) => entry.legacyTables.includes('TBL_ALUNO'));
    expect(fromStudents.map((entry) => entry.entity).sort()).toEqual(['guardians', 'students']);
  });

  it('deixa payments e users fora da conciliacao de proveniencia', () => {
    const entities = COVERAGE_MAP.map((entry) => entry.entity as string);
    expect(entities).not.toContain('payments');
    expect(entities).not.toContain('users');
  });
});
