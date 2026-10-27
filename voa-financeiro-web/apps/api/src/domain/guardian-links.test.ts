import { describe, expect, it } from 'vitest';
import {
  GUARDIAN_LINK_STATUSES,
  GUARDIAN_LINK_TITLES,
  classifyGuardianLink,
  isGuardianLinkStatus,
  parseLinkOffset,
  suggestCandidate,
  type GuardianLinkCandidate
} from './guardian-links.js';

const candidate = (overrides: Partial<GuardianLinkCandidate> = {}): GuardianLinkCandidate => ({
  customerId: '11111111-1111-4111-8111-111111111111',
  fullName: 'Maria da Silva',
  legacyTable: 'TBL_PAGAMENTO',
  legacyId: '42',
  agreements: 1,
  ...overrides
});

describe('classificacao do vinculo responsavel -> cliente', () => {
  it('mantem o vinculo ja confirmado mesmo sem candidato', () => {
    expect(
      classifyGuardianLink({
        linkedCustomerId: '22222222-2222-4222-8222-222222222222',
        payers: 0,
        candidates: []
      })
    ).toBe('linked');
  });

  it('um pagador com o nome do responsavel e `single`', () => {
    expect(classifyGuardianLink({ linkedCustomerId: null, payers: 1, candidates: [candidate()] })).toBe('single');
  });

  it('duas linhas de pagador com o mesmo nome sao `ambiguous`', () => {
    expect(
      classifyGuardianLink({
        linkedCustomerId: null,
        payers: 2,
        candidates: [candidate({ legacyId: '42' }), candidate({ legacyId: '43' })]
      })
    ).toBe('ambiguous');
  });

  it('separa pagador com outro nome de aluno sem pagador', () => {
    expect(classifyGuardianLink({ linkedCustomerId: null, payers: 3, candidates: [] })).toBe('no_match');
    expect(classifyGuardianLink({ linkedCustomerId: null, payers: 0, candidates: [] })).toBe('no_payer');
  });

  it('nao depende do numero de candidatos vir como lista valida', () => {
    // O driver pode devolver `null` em vez de `[]`; isso e "sem candidato", nao excecao.
    expect(
      classifyGuardianLink({
        linkedCustomerId: null,
        payers: 1,
        candidates: undefined as unknown as GuardianLinkCandidate[]
      })
    ).toBe('no_match');
  });
});

describe('sugestao automatica', () => {
  it('so sugere quando ha um unico candidato', () => {
    expect(suggestCandidate({ linkedCustomerId: null, payers: 1, candidates: [candidate()] })?.legacyId).toBe('42');
  });

  it('nao escolhe entre duas linhas do mesmo nome', () => {
    expect(
      suggestCandidate({
        linkedCustomerId: null,
        payers: 2,
        candidates: [candidate({ legacyId: '42', agreements: 3 }), candidate({ legacyId: '43' })]
      })
    ).toBeNull();
  });

  it('nao sugere nada quando o vinculo ja existe', () => {
    expect(
      suggestCandidate({
        linkedCustomerId: '22222222-2222-4222-8222-222222222222',
        payers: 1,
        candidates: [candidate()]
      })
    ).toBeNull();
  });
});

describe('vocabulario da fila', () => {
  it('reconhece exatamente as cinco situacoes', () => {
    expect(GUARDIAN_LINK_STATUSES).toHaveLength(5);
    for (const status of GUARDIAN_LINK_STATUSES) {
      expect(isGuardianLinkStatus(status)).toBe(true);
      expect(GUARDIAN_LINK_TITLES[status].length).toBeGreaterThan(10);
    }
    expect(isGuardianLinkStatus('unknown')).toBe(false);
    expect(isGuardianLinkStatus('')).toBe(false);
  });
});

describe('offset da fila', () => {
  it('cai em zero para valor ausente ou invalido', () => {
    expect(parseLinkOffset(undefined)).toBe(0);
    expect(parseLinkOffset('')).toBe(0);
    expect(parseLinkOffset('abc')).toBe(0);
    expect(parseLinkOffset('-10')).toBe(0);
  });

  it('corta a fracao e respeita o teto', () => {
    expect(parseLinkOffset('50')).toBe(50);
    expect(parseLinkOffset('9.9')).toBe(9);
    expect(parseLinkOffset('999999999')).toBe(100_000);
  });
});
