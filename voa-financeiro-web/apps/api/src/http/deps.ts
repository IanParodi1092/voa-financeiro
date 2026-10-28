import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import type { PatchRunner } from './patch-runner.js';

/**
 * `wake()` do laco da fila, quando ele existe nesta instancia.
 *
 * O worker sobe em `server.ts`, depois de `buildApp`, entao a rota recebe uma referencia mutavel
 * cujo metodo e trocado quando o laco nasce. Chamar `wake` depois do `COMMIT` e otimizacao: o poll
 * de 2s pega a linha de qualquer forma, e no teste de integracao (sem laco) fica `undefined`.
 */
export interface OutboxWaker {
  wake(): void;
}

/**
 * O que um modulo de rotas precisa do processo: banco, configuracao, o executor de `PATCH` e o
 * acordador da fila.
 *
 * `pool` continua opcional porque a API sobe sem banco (rotas respondem 503, `/health/ready`
 * responde `not-configured`), e os testes unitarios exercitam esse caminho.
 */
export interface RouteDeps {
  pool?: Pool;
  config: AppConfig;
  patchRunner: PatchRunner;
  outbox?: OutboxWaker;
}
