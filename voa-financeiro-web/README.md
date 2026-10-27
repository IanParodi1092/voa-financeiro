# VOA Financeiro Web

Novo monorepo TypeScript para a substituicao gradual do Canvas App. A API e o componente prioritario desta fundacao; o frontend React e um shell enxuto: login e as telas de clientes, alunos, escolas e a fila de responsaveis (somente leitura).

## Execucao local

1. Instale Node.js 20+ e PostgreSQL local — o Postgres local e o alvo do projeto; nenhum provedor gerenciado e necessario.
2. Copie `.env.example` para `.env` na raiz do monorepo e ajuste apenas os valores do ambiente local (as variaveis `SUPABASE_*` do seu `.env` sao ignoradas: o schema de configuracao nao as conhece).
3. Execute `npm install` na raiz.
4. Execute `npm run db:migrate` para aplicar migrations.
5. Execute `npm run dev:api` e verifique `GET http://localhost:3000/health/live`.
6. Em outro terminal, execute `npm run dev:web` para iniciar a SPA.

Nenhuma credencial real nem dado legado versionado faz parte deste repositorio, e nenhuma chamada a Asaas/ChatGuru/SMTP acontece sem configuracao de ambiente.

## Validacao

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:integration` (testes de auth, RBAC, dominio e migracao; exigem `TEST_DATABASE_URL`, ver `docs/LOCAL_DEVELOPMENT.md`; sem ela o bloco e ignorado)
- `npm run test:python` (scripts de migracao; requer `scripts/requirements.txt`)

## Migracao do legado

- `docs/MIGRATION_WORKFLOW.md` descreve fases, regras de seguranca e comandos.
- `docs/STAGING_VALIDATION_REPORT.md` traz o relatorio da ultima validacao de staging.
- `docs/FIELD_MAPPING_DICTIONARY.md` traz o dicionario da fase 2 (toda coluna legada com decisao, destino, tipo e pendencia).
- `docs/FIELD_MAPPING_TRIAGE.md` faz a triagem das colunas `review`: o que cada uma e no dado, a decisao por classe e o impacto no portao de aprovacao. Em 2026-10-27 o portao fechou em `0 review` (classes A, A', B, C, D e E aplicadas; `0009`/`0010`/`0011` resolveram `contacts.legacy_id`, `installments.legacy_id`, `agreements.closed_at` e as tabelas de responsavel/contato do aluno), entao a carga roda sem `--allow-proposed`.
- `docs/CANONICAL_LOAD_REPORT.md` traz o relatorio da ultima carga canonica (plano por entidade, linhas carregadas, achados e bloqueios).
- `docs/LEGACY_APP_SOURCE_GAPS.md` compara o Canvas App legado com as planilhas: tabelas e campos que a app le e o workbook nao tem.
- `scripts/profile_legacy_workbook.py`, `scripts/stage_legacy_workbook.py` e `scripts/validate_staging_batch.py` operam em modo somente leitura sobre as fontes e escrevem apenas tabelas de staging.
- `scripts/audit_legacy_app_sources.py` (`npm run db:audit-app-sources`) le a copia descompactada da app, o workbook e a solucao Dataverse e regenera `docs/LEGACY_APP_SOURCE_GAPS.md` sem conectar no banco.
- `scripts/load_canonical_batch.py` executa a fase 7 (`npm run db:load-canonical` e um dry-run; `npm run db:load-canonical-commit` escreve). A carga e idempotente: rodar de novo reutiliza os UUIDs pela chave legada e nao duplica linhas.
- `scripts/legacy_field_map.json` guarda o dicionario e `scripts/build_field_dictionary.py` o resolve e audita contra `apps/api/migrations/*.sql`.

## Estado atual e proximos passos

Fundacao entregue: autenticacao, RBAC, schema canonico, migracao do legado e os primeiros contratos de escrita do dominio.

Situacao em 2026-10-27: autenticacao com rotacao de refresh, RBAC por permissao, trilha em `audit_logs`, os contratos `PATCH` parciais (auditados como `<entidade>.updated`), as rotas de migracao (`/api/v1/migrations`: registro do lote, gate de `validate`/`commit` e triagem de achados, exclusivas do `admin`) e os testes de integracao com PostgreSQL descartavel (`npm run test:integration` com `TEST_DATABASE_URL`) estao implementados. A migracao do legado fechou o dicionario (`0 review`, `0 proposed`) e a carga canonica local rodou completa: `150.018` linhas em `10` entidades, com `agreements.reference` materializado. As rotas de leitura e escrita do dominio de aluno tambem entraram (`/api/v1/students/:studentId/guardians`, `/api/v1/students/:studentId/contacts`, `PATCH /api/v1/guardians/:id` e `PATCH /api/v1/student-contacts/:id`) e o `PATCH /api/v1/agreements/:id` passou a aceitar `closedAt`. Rotas e permissoes em `docs/API_ROUTES.md`.

O que falta: reconciliar o pos-corte no banco local (3 linhas sem `legacy_source`, R$ 1.362,48 de divergencia acordo/parcela, 24 contatos atras do ensaio), a acao de vincular responsavel -> cliente **na tela** (a fila ja e lida pela SPA e o `PATCH /api/v1/guardians/:id` ja grava; falta o botao que envia o par) e os adaptadores Asaas, ChatGuru e SMTP usando segredos por ambiente. O Supabase saiu do caminho critico em 2026-10-27: o canonico oficial e o PostgreSQL local, e migrar para um Postgres gerenciado depois e so trocar `DATABASE_URL`/`DIRECT_DATABASE_URL`/`STAGING_DATABASE_URL`.