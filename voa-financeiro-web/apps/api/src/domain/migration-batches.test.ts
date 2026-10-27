import { describe, expect, it } from 'vitest';
import {
  BATCH_STATUSES,
  canCommit,
  canValidate,
  evaluateGate,
  registerBatchSchema,
  resolveFindingSchema,
  type BatchStatus,
  type GateCounts
} from './migration-batches.js';

/** Contagens de um lote pronto: linhas estagiadas, nenhum achado aberto e reconciliacao gravada. */
const clean = (): GateCounts => ({
  rowsTotal: 10,
  rowsInError: 0,
  openFindings: { blocking: 0, error: 0 },
  reconciliationReports: 3
});

const gate = (counts: Partial<GateCounts>) => evaluateGate({ ...clean(), ...counts }, 'validate');

describe('gate do lote de migracao', () => {
  it('libera o lote sem achado aberto, linha em erro ou falta de reconciliacao', () => {
    expect(evaluateGate(clean(), 'validate')).toEqual({ ok: true, blockers: [] });
    expect(evaluateGate(clean(), 'commit')).toEqual({ ok: true, blockers: [] });
  });

  it('recusa lote vazio, linha em erro e achado aberto, na ordem declarada', () => {
    expect(gate({ rowsTotal: 0 })).toEqual({ ok: false, blockers: ['NO_ROWS'] });
    expect(gate({ rowsInError: 2 })).toEqual({ ok: false, blockers: ['ROWS_IN_ERROR'] });
    expect(gate({ openFindings: { blocking: 1, error: 0 } }))
      .toEqual({ ok: false, blockers: ['OPEN_BLOCKING_FINDINGS'] });
    expect(gate({ openFindings: { blocking: 0, error: 4 } }))
      .toEqual({ ok: false, blockers: ['OPEN_ERROR_FINDINGS'] });
    expect(gate({ rowsTotal: 0, rowsInError: 1, openFindings: { blocking: 1, error: 1 } })).toEqual({
      ok: false,
      blockers: ['NO_ROWS', 'ROWS_IN_ERROR', 'OPEN_BLOCKING_FINDINGS', 'OPEN_ERROR_FINDINGS']
    });
  });

  it('exige reconciliacao no commit, mas nao no validate', () => {
    const counts = clean();
    counts.reconciliationReports = 0;
    expect(evaluateGate(counts, 'validate')).toEqual({ ok: true, blockers: [] });
    expect(evaluateGate(counts, 'commit')).toEqual({ ok: false, blockers: ['NO_RECONCILIATION'] });
  });

  it('nao reabre lote committed, rolled_back ou failed e nao commita lote nao validado', () => {
    const validatable: BatchStatus[] = ['profiled', 'staging', 'validated', 'approved'];
    const committable: BatchStatus[] = ['validated', 'approved'];
    for (const status of BATCH_STATUSES) {
      expect({ status, canValidate: canValidate(status) }).toEqual({ status, canValidate: validatable.includes(status) });
      expect({ status, canCommit: canCommit(status) }).toEqual({ status, canCommit: committable.includes(status) });
    }
  });
});

describe('schemas das rotas de migracao', () => {
  const hash = 'a'.repeat(64);
  const codes = (body: unknown): string[] => {
    const parsed = registerBatchSchema.safeParse(body);
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.code);
  };

  it('aceita o registro minimo e aplica os defaults', () => {
    const parsed = registerBatchSchema.parse({ sourceName: 'VOA.xlsx', sourceHash: hash });
    expect(parsed).toEqual({ sourceName: 'VOA.xlsx', sourceHash: hash, sourceKind: 'xlsx', rowCount: 0 });
  });

  it('recusa hash que nao e sha256, contagem negativa e campo desconhecido', () => {
    // Codigos do zod v4: formato de string vira `invalid_format` (no v3 era `invalid_string`) e valor
    // fora do enum vira `invalid_value` (no v3 era `invalid_enum_value`). Os testes seguem o codigo
    // da biblioteca de proposito: e o que garante que a recusa vem da regra certa.
    expect(codes({ sourceName: 'VOA.xlsx', sourceHash: 'abc' })).toEqual(['invalid_format']);
    expect(codes({ sourceName: 'VOA.xlsx', sourceHash: hash.toUpperCase() })).toEqual(['invalid_format']);
    expect(codes({ sourceName: 'VOA.xlsx', sourceHash: hash, rowCount: -1 })).toEqual(['too_small']);
    expect(codes({ sourceName: 'VOA.xlsx', sourceHash: hash, sourceKind: 'pdf' })).toEqual(['invalid_value']);
    expect(codes({ sourceName: 'VOA.xlsx', sourceHash: hash, status: 'committed' })).toEqual(['unrecognized_keys']);
    expect(codes({ sourceHash: hash })).toEqual(['invalid_type']);
  });

  it('aceita resolucao sem nota e recusa nota vazia ou campo desconhecido', () => {
    expect(resolveFindingSchema.parse({})).toEqual({});
    expect(resolveFindingSchema.parse({ note: '  conferido na planilha  ' })).toEqual({ note: 'conferido na planilha' });
    expect(resolveFindingSchema.safeParse({ note: '   ' }).success).toBe(false);
    expect(resolveFindingSchema.safeParse({ resolvedAt: '2026-10-22' }).success).toBe(false);
  });
});
