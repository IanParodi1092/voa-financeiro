# VOA Financeiro

Substituicao do Canvas App de gestao financeira da VOA por um monorepo TypeScript (API + SPA) com migracao do legado PowerApps/Dataverse para PostgreSQL.

## Layout

| Caminho | O que e |
|---|---|
| `voa-financeiro-web/` | Monorepo Node (`apps/api` + `apps/web`), migrations SQL, scripts de migracao do legado e toda a documentacao (`voa-financeiro-web/docs/`) |
| `.azure/` | Planos e requisitos do projeto (`project-plan.md`, `integration-plan.md`, `requirements.json`) |

As fontes legadas (`_legacy-powerapps/`: `root-exports/VOA.xlsx`, copia da app, solucao Dataverse) **nao** sao versionadas — os scripts leem do disco local. Nenhuma credencial entra no repositorio: `.env` e ignorado e `.env.example` e o unico arquivo de ambiente versionado.

## Comecar

```powershell
cd voa-financeiro-web
npm install
Copy-Item .env.example .env       # ajuste as credenciais locais
npm run db:migrate
npm run dev:api                   # GET http://localhost:3000/health/live
npm run dev:web
```

Primeiro administrador: `npm --workspace apps/api run auth:create-admin`.

## Validacao

`npm run typecheck` · `npm test` · `npm run build` · `npm run test:integration` (exige `TEST_DATABASE_URL`) · `npm run test:python`

## Documentacao

Comece por `voa-financeiro-web/README.md`. Para a migracao, a ordem de leitura e `docs/MIGRATION_WORKFLOW.md` -> `docs/FIELD_MAPPING_TRIAGE.md` -> `docs/CANONICAL_DATA_RULES.md` -> `docs/CANONICAL_LOAD_REPORT.md`. Rotas e permissoes da API em `docs/API_ROUTES.md`; ambiente local em `docs/LOCAL_DEVELOPMENT.md`.

## Estado em 2026-10-27

- Dicionario de campos fechado: `46 map` / `79 ignore` / `731 defer`, `0 review`, `0 proposed`; o portao `npm run db:field-dictionary-check` sai em `exit 0`.
- Carga canonica local completa: `150.018` linhas em `10` entidades, `agreements.reference` materializado em `1.504` das `1.505` linhas.
- Backend com autenticacao/RBAC, `audit_logs`, contratos `PATCH` por entidade e leitura/escrita de responsaveis e contatos do aluno.
- Pendente: aplicar `0009`/`0010`/`0011` e a carga no Supabase (somente-leitura por cota de disco), reconciliacao pos-corte e os adaptadores Asaas/ChatGuru/SMTP.
