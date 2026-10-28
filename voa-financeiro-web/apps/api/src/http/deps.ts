import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import type { PatchRunner } from './patch-runner.js';

/**
 * `wake()` de um laco desta instancia (fila de saida ou consumidor de eventos).
 *
 * Os lacos sobem em `server.ts`, depois de `buildApp`, entao as rotas recebem referencia mutavel cujo
 * metodo e trocado quando o laco nasce. Chamar `wake` depois do `COMMIT` e otimizacao: o poll de 2s
 * pega a linha de qualquer forma, e no teste de integracao (sem laco) o campo fica `undefined`.
 */
export interface Waker {
  wake(): void;
}

/**
 * O que um modulo de rotas precisa do processo: banco, configuracao, o executor de `PATCH` e os
 * acordadores dos lacos.
 *
 * `pool` continua opcional porque a API sobe sem banco (rotas respondem 503, `/health/ready`
 * responde `not-configured`), e os testes unitarios exercitam esse caminho.
 */
export interface RouteDeps {
  pool?: Pool;
  config: AppConfig;
  patchRunner: PatchRunner;
  /** Fila de saida (`outbox_events`), acordada pelos produtores. */
  outbox?: Waker;
  /** Entrada (`asaas_events`), acordada pelo webhook. */
  asaasEvents?: Waker;
}
