import type { Pool } from 'pg';
import type { AppConfig } from '../config.js';
import type { PatchRunner } from './patch-runner.js';

/**
 * O que um modulo de rotas precisa do processo: banco, configuracao e o executor de `PATCH`.
 *
 * `pool` continua opcional porque a API sobe sem banco (rotas respondem 503, `/health/ready`
 * responde `not-configured`), e os testes unitarios exercitam esse caminho.
 */
export interface RouteDeps {
  pool?: Pool;
  config: AppConfig;
  patchRunner: PatchRunner;
}
