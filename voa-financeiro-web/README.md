# VOA Financeiro Web

Novo monorepo TypeScript para a substituicao gradual do Canvas App. A API e o componente prioritario desta fundacao; o frontend React e apenas um shell inicial.

## Execucao local

1. Instale Node.js 20+ e PostgreSQL local (ou use uma instancia Supabase de desenvolvimento).
2. Copie `.env.example` para `.env` na raiz do monorepo e ajuste apenas os valores do ambiente local.
3. Execute `npm install` na raiz.
4. Execute `npm run db:migrate` para aplicar migrations.
5. Execute `npm run dev:api` e verifique `GET http://localhost:3000/health/live`.
6. Em outro terminal, execute `npm run dev:web` para iniciar a SPA.

Nenhuma credencial real, dado legado ou chamada a Asaas/ChatGuru/Supabase remoto faz parte deste scaffold.

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
- `docs/FIELD_MAPPING_TRIAGE.md` faz a triagem das colunas `review`: o que cada uma e no dado, a decisao por classe e o impacto no portao de aprovacao (em 2026-10-22 as classes A, B e E foram aplicadas e a `0009` resolveu `contacts.legacy_id`/`installments.legacy_id`, com backfill por `npm run db:backfill-legacy-provenance`).
- `docs/CANONICAL_LOAD_REPORT.md` traz o relatorio da ultima carga canonica (plano por entidade, linhas carregadas, achados e bloqueios).
- `docs/LEGACY_APP_SOURCE_GAPS.md` compara o Canvas App legado com as planilhas: tabelas e campos que a app le e o workbook nao tem.
- `scripts/profile_legacy_workbook.py`, `scripts/stage_legacy_workbook.py` e `scripts/validate_staging_batch.py` operam em modo somente leitura sobre as fontes e escrevem apenas tabelas de staging.
- `scripts/audit_legacy_app_sources.py` (`npm run db:audit-app-sources`) le a copia descompactada da app, o workbook e a solucao Dataverse e regenera `docs/LEGACY_APP_SOURCE_GAPS.md` sem conectar no banco.
- `scripts/load_canonical_batch.py` executa a fase 7 (`npm run db:load-canonical` e um dry-run; `npm run db:load-canonical-commit` escreve). A carga e idempotente: rodar de novo reutiliza os UUIDs pela chave legada e nao duplica linhas.
- `scripts/legacy_field_map.json` guarda o dicionario e `scripts/build_field_dictionary.py` o resolve e audita contra `apps/api/migrations/*.sql`.

## Proximos passos

Implementar autenticacao/RBAC e o schema de dominio por fases, adicionar testes de integracao com PostgreSQL descartavel, e somente depois conectar adaptadores Asaas, ChatGuru e SMTP usando segredos por ambiente.

Situacao em 2026-10-22: autenticacao com rotacao de refresh, RBAC por permissao, trilha em `audit_logs`, os contratos `PATCH` parciais (auditados como `<entidade>.updated`), as rotas de migracao (`/api/v1/migrations`: registro do lote, gate de `validate`/`commit` e triagem de achados, exclusivas do `admin`) e os testes de integracao com PostgreSQL descartavel (`npm run test:integration` com `TEST_DATABASE_URL`) estao implementados; rotas e permissoes em `docs/API_ROUTES.md`, preparo do banco de teste em `docs/LOCAL_DEVELOPMENT.md`. O que falta: a carga canonica no Supabase, que segue somente-leitura por cota de disco (`docs/MIGRATION_WORKFLOW.md`), e os adaptadores Asaas, ChatGuru e SMTP.