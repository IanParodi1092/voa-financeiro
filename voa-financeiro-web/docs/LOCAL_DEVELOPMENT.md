# Desenvolvimento local

O backend exige `DATABASE_URL` apenas para o readiness check e para o runner de migrations. O endpoint `GET /health/live` nao depende do banco; `GET /health/ready` testa a conectividade sem expor detalhes.

Use somente banco local (PostgreSQL). Projeto Supabase **nao** faz parte do caminho atual: decisao de 2026-10-27 removeu-o do escopo imediato. Nunca coloque `.env` no controle de versao — o modelo versionado e `.env.example`. As integrações externas permanecem desativadas até existir configuração e testes de homologação.

## Scripts Python de migracao

Os scripts em `scripts/` usam Python 3.11+ com as dependencias de `scripts/requirements.txt`:

```powershell
python -m pip install -r scripts/requirements.txt
```

- `python -m unittest discover -s scripts -p "test_*.py"` (ou `npm run test:python`) executa os testes dos scripts.
- `npm run db:profile-legacy` perfila o workbook legado em modo somente leitura.
- `npm run db:stage-dry-run` cria/atualiza o lote de staging.
- `npm run db:validate-staging` valida o lote de staging e escreve apenas achados e relatorios.
- `npm run db:field-dictionary` resolve o dicionario de campos (fase 2) contra o schema real e regrava `docs/FIELD_MAPPING_DICTIONARY.md`; nao toca no banco.
- `npm run db:field-dictionary-check` faz o mesmo com `--from-staging --gate approved`, comparando as colunas do workbook com o payload do lote e falhando enquanto houver decisao pendente (hoje sai `0`: nenhuma coluna em `review` e nenhum `map` sem `status: "confirmed"`).
- `npm run db:load-canonical` executa a carga canonica (fase 7) como dry-run: monta o plano por entidade, conta as linhas e registra os achados sem escrever nada.
- `npm run db:load-canonical-commit` faz a carga real (`--commit`). Ela e idempotente e hoje carrega todas as tabelas mapeadas sem flag: as 11 propostas que existiam (`Pagamento_Nome -> agreements.reference`, `guardians` e `student_contacts`) foram confirmadas pelo operador em 2026-10-27. `--allow-proposed <tabela>` continua existindo como rede de seguranca para uma regra `status: "proposed"` nova, mas com o dicionario atual nao muda nada. `--enrich-reused` (so com `--commit`) completa as colunas `NULL` das linhas que foram **reutilizadas** pela chave legada, sempre com `COALESCE` (o valor gravado vence): foi o que materializou `agreements.reference` em `1.504` das `1.505` linhas sem reescrever nada. `asaas_charges` nao esta no plano de carga (decisao de 2026-10-27, ver `docs/MIGRATION_WORKFLOW.md`).
- `npm run db:backfill-legacy-provenance` carimba `legacy_source`/`legacy_table`/`legacy_id` nas linhas de `contacts` e `installments` que foram gravadas antes da `0009`, recalculando o UUID deterministico (`uuid5("aba:linha")`) de cada linha de origem; dry-run por padrao, grava com `--commit`. Ele so reporta divergencia (linha com chave gravada diferente da origem) e nunca sobrescreve. A ordem e `db:migrate` -> backfill `--commit` -> carga: habilitar o provedor de chave legada antes do carimbo faz a carga recusar as linhas existentes como duplicidade.

Os scripts leem `DATABASE_URL`/`DIRECT_DATABASE_URL` do `.env` do monorepo e nunca imprimem valores de colunas sensiveis.

### Acentos no Windows: use `--json-out` e `--report`, nao `>`

O interpretador deste ambiente escreve stdout em **cp1252**, enquanto o PowerShell 5.1
decodifica um fluxo redirecionado em **cp850**. Redirecionar com `>` produz mojibake visual
mesmo quando o dado esta correto (`Não` aparece como `NÒo`, `Colégio` como `ColÚgio`).
Portanto:

```powershell
# recomendado: o script grava UTF-8 direto no arquivo
npm run db:validate-staging -- --report docs/STAGING_VALIDATION_REPORT.md --json-out "$env:TEMP\voa_validation.json"

# se realmente precisar do console com acentos corretos
chcp 65001
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
```

Diagnostico completo em `docs/MIGRATION_WORKFLOW.md` ("Investigacao de encoding e acentos").

## Banco local para a API e para os testes de integracao

O **PostgreSQL local e o alvo do projeto** (decisao de 2026-10-27: o Supabase sai do
caminho critico). A carga canonica da revisao de 546.346 linhas ja esta commitada nesse
banco, e e nele que a API, as migrations, a carga e os testes de integracao rodam:

```powershell
# a API le o canonico local e o staging continua na mesma instancia
$env:DATABASE_URL = "postgresql://postgres:SENHA@localhost:5434/voa_staging"
npm run db:migrate      # aplica 0007_auth_refresh_tokens.sql (login com refresh + rotacao)
npm run dev:api
```

O `.env` do repositorio aponta `DATABASE_URL`, `DIRECT_DATABASE_URL` e
`STAGING_DATABASE_URL` para esse container, e as variaveis `SUPABASE_*` que sobraram no
arquivo sao **ignoradas**: o schema de configuracao (`apps/api/src/config.ts`) nao as
conhece e o zod descarta chaves desconhecidas. Nao ha flag para trocar de banco em tempo
de execucao — `load_canonical_batch.py` e companhia leem sempre `DIRECT_DATABASE_URL`/
`DATABASE_URL`. O modelo de `.env` versionado e o `.env.example` desta pasta.

Para apontar para outro Postgres (outra maquina, outro container), basta trocar as tres
URLs — nada no codigo e especifico de um provedor. Um Postgres gerenciado (Supabase,
Neon, RDS) funciona como destino futuro, mas nao faz parte do escopo atual.

Os testes de integracao de auth/RBAC usam **PostgreSQL descartavel**: as migrations rodam num schema
temporario (`search_path`) que e removido no fim, entao o banco escolhido nao e alterado.

```powershell
# uma vez por maquina: crie o banco descartavel (o nome precisa ser diferente do canonico)
createdb -h localhost -p 5434 -U postgres voa_api_test          # ou: CREATE DATABASE voa_api_test;
$env:TEST_DATABASE_URL = "postgresql://postgres:SENHA@localhost:5434/voa_api_test"
npm run test:integration
# ao terminar, remova para nao deixar lixo: DROP DATABASE voa_api_test;
```

Se o Postgres estiver em container, o mesmo passo e `docker exec <container> createdb -U postgres
voa_api_test`. Sem o banco criado, o bloco de integracao falha na conexao (nao e pulado: o skip
depende apenas de `TEST_DATABASE_URL` estar definida).

Sem `TEST_DATABASE_URL` o bloco inteiro e ignorado, entao `npm test` permanece verde em maquina sem
banco. Os testes cobrem login (sucesso e falha auditada), cookie `voa_refresh` httpOnly,
`/auth/me`, rotacao do refresh (reuso do token antigo recebe 401), RBAC (`viewer` recebe 403 nas
escritas), a cadeia `schools`/`customers`/`students`/`contacts`/`agreements`/`installments`/`payments`,
os `PATCH` parciais (inclusive o gate de retencao, o `closedAt` do acordo e os `PATCH` de `guardians`
e `student-contacts`) e as rotas de migracao (registro idempotente do
lote, `validate`/`commit` com bloqueio aberto, triagem de achado) - com `GET /audit-logs` restrito ao
`admin`. `npm test` (unitario) cobre as mesmas rotas sem banco: os `GET` de guardiao/contato do aluno
respondem `503` sem pool e `400` com id malformado, e o corpo do `PATCH` e validado antes do banco.

Para criar o primeiro administrador no banco local, aponte as duas variaveis (`create-admin` prefere
`DIRECT_DATABASE_URL`) e informe e-mail e senha temporarios. O script `auth:create-admin` vive no
workspace `apps/api` (nao ha alias no `package.json` da raiz), entao o comando sai por `--workspace`:

```powershell
$env:DIRECT_DATABASE_URL = "postgresql://postgres:SENHA@localhost:5434/voa_staging"
$env:ADMIN_EMAIL = "admin@voa.local"
$env:ADMIN_PASSWORD = "troque-esta-senha-123"
npm --workspace apps/api run auth:create-admin
```

O login devolve o access token e o cookie `voa_refresh`; a senha temporaria deve ser trocada assim que
o operador tiver a tela de perfil.

## Build da API, testes e dependencias

`npm --workspace apps/api run build` usa `apps/api/tsconfig.build.json`, que herda o `tsconfig.json` e
exclui `src/**/*.test.ts`: o `dist` gerado tem so o que a API executa. O `typecheck` continua no
`tsconfig.json` e por isso confere os testes tambem — sao dois alvos de proposito, nao duplicacao.

`apps/api/vitest.config.ts` fixa `include: ["src/**/*.test.ts"]`. O include existe porque o build
compila `src` inteiro para `dist`: sem ele o Vitest tambem carrega `dist/**/*.test.js` e cada caso
roda duas vezes, a segunda contra uma copia velha do teste.

`npm audit` esta em **0 vulnerabilidades** (verificado em 2026-10-27). Tres majors recentes mudaram
contrato e valem a lembranca:

- `zod` 4 — os codigos de issue mudaram: formato de string e `invalid_format` (era `invalid_string`) e
  valor fora do enum e `invalid_value` (era `invalid_enum_value`). Nenhum schema usava API removida:
  `.strict()`, `.email()`, `.date()`, `.datetime()` e `.uuid()` seguem funcionando (agora como alias
  deprecated). `apps/api/src/domain/migration-batches.test.ts` e o unico lugar que compara codigo de
  issue.
- `vitest` 5 — exige Node `^22.12 || ^24`, enquanto o `engines` da raiz continua `>=20` (intencional: a
  API roda em Node 20, o runner de testes nao). Em Node 20 o `npm test` falha, entao o toolchain de
  desenvolvimento precisa de 22.12+.
- `fastify` 5.12.7 + `fast-jwt` corrigidos — vieram por `npm audit fix` dentro do semver, sem mudanca de
  codigo; os 33 testes de integracao de auth/refresh cobrem o caminho.


