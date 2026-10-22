import { describe, expect, it } from 'vitest';
import { patchSpecs, type PatchEntity } from './patch-specs.js';

const entities = Object.keys(patchSpecs) as PatchEntity[];

/** Zod issue codes of a body, or `[]` when it was accepted. */
const issueCodes = (entity: PatchEntity, body: unknown): string[] => {
  const parsed = patchSpecs[entity].schema.safeParse(body);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.code);
};

describe('especificacoes de PATCH', () => {
  it('declara uma coluna para cada campo validado', () => {
    for (const entity of entities) {
      const fields = Object.keys(patchSpecs[entity].schema.shape).sort();
      expect({ entity, fields }).toEqual({ entity, fields: Object.keys(patchSpecs[entity].columns).sort() });
      expect(fields.length).toBeGreaterThan(0);
    }
  });

  it('recusa campo desconhecido no corpo', () => {
    for (const entity of entities) {
      expect({ entity, codes: issueCodes(entity, { naoExiste: 'x' }) }).toMatchObject({ entity, codes: ['unrecognized_keys'] });
    }
  });

  it('usa colunas snake_case e nao expoe chaves estruturais', () => {
    const forbidden = ['id', 'created_at', 'updated_at', 'deleted_at'];
    for (const entity of entities) {
      for (const column of Object.values(patchSpecs[entity].columns)) {
        expect(column).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/u);
        expect(forbidden).not.toContain(column);
        expect(column.startsWith('legacy_')).toBe(false);
      }
    }
  });

  it('projeta id, updatedAt e a data de criacao no RETURNING', () => {
    for (const entity of entities) {
      const { returning } = patchSpecs[entity];
      expect(returning).toContain('id');
      expect(returning).toContain('created_at AS "createdAt"');
      expect(returning).toContain('updated_at AS "updatedAt"');
    }
  });

  it('desativa a checagem de deleted_at apenas em payments', () => {
    // `payments` (0004) nao tem `deleted_at`; as outras cinco tabelas do PATCH tem.
    expect(patchSpecs.payments.softDelete).toBe(false);
    for (const entity of entities.filter((name) => name !== 'payments')) {
      expect({ entity, softDelete: patchSpecs[entity].softDelete }).toEqual({ entity, softDelete: true });
    }
  });

  it('aceita corpo vazio no schema, porque a recusa EMPTY_PATCH e do handler', () => {
    for (const entity of entities) {
      expect({ entity, accepted: patchSpecs[entity].schema.safeParse({}).success }).toEqual({ entity, accepted: true });
    }
  });

  it('distingue campo ausente de campo nulo', () => {
    const cleared = patchSpecs.customers.schema.safeParse({ phone: null });
    expect(cleared.success && cleared.data).toEqual({ phone: null });
    const absent = patchSpecs.customers.schema.safeParse({});
    expect(absent.success && absent.data).toEqual({});
    expect(patchSpecs.customers.schema.safeParse({ fullName: null }).success).toBe(false);
  });

  it('normaliza o email do cliente para minusculas', () => {
    const parsed = patchSpecs.customers.schema.safeParse({ email: 'FULANO@Example.com' });
    expect(parsed.success && parsed.data.email).toBe('fulano@example.com');
  });

  it('valida os campos de retencao do pagamento', () => {
    const valid = patchSpecs.payments.schema.safeParse({
      retentionStatus: 'released',
      retentionPercentage: 0.25,
      retentionApprovedAt: '2026-10-01',
      retentionScheduledMonth: '2026-11',
      retentionReleasedAt: '2026-11-20'
    });
    expect(valid.success).toBe(true);

    const invalid = [
      { retentionStatus: 'aprovado' },
      { retentionPercentage: 1.5 },
      { retentionPercentage: -0.1 },
      { retentionScheduledMonth: '2026-13' },
      { retentionScheduledMonth: '11/2026' },
      { retentionApprovedAt: '01/10/2026' },
      { retainedAmount: -1 }
    ];
    for (const body of invalid) {
      expect({ body, accepted: patchSpecs.payments.schema.safeParse(body).success }).toEqual({ body, accepted: false });
    }
  });

  it('recusa texto vazio e nome com um caractere', () => {
    expect(patchSpecs.schools.schema.safeParse({ legalName: 'A' }).success).toBe(false);
    expect(patchSpecs.schools.schema.safeParse({ tradeName: '   ' }).success).toBe(false);
    const trimmed = patchSpecs.schools.schema.safeParse({ legalName: '  Colegio X  ' });
    expect(trimmed.success && trimmed.data.legalName).toBe('Colegio X');
  });
});
