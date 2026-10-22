# Desenvolvimento local

O backend exige `DATABASE_URL` apenas para o readiness check e para o runner de migrations. O endpoint `GET /health/live` nao depende do banco; `GET /health/ready` testa a conectividade sem expor detalhes.

Use somente banco local ou projeto Supabase de desenvolvimento. Nunca coloque `.env` no controle de versao. As integrações externas permanecem desativadas até existir configuração e testes de homologação.

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
- `npm run db:field-dictionary-check` faz o mesmo com `--from-staging --gate approved`, comparando as colunas do workbook com o payload do lote e falhando enquanto houver decisao pendente.
- `npm run db:load-canonical` executa a carga canonica (fase 7) como dry-run: monta o plano por entidade, conta as linhas e registra os achados sem escrever nada.
- `npm run db:load-canonical-commit` faz a carga real (`--commit`). Ela e idempotente e aceita `--allow-proposed contacts` para liberar explicitamente um mapeamento ainda marcado como `proposed`.

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

Com o Supabase de desenvolvimento em somente-leitura (cota de disco) e a carga canonica da revisao
de 546.346 linhas ja commitada no Postgres local, o caminho de desenvolvimento passa a ser o
container local:

```powershell
# a API le o canonico local e o staging continua na mesma instancia
$env:DATABASE_URL = "postgresql://postgres:SENHA@localhost:5434/voa_staging"
npm run db:migrate      # aplica 0007_auth_refresh_tokens.sql (login com refresh + rotacao)
npm run dev:api
```

O `.env` do repositorio ja aponta `DATABASE_URL` e `DIRECT_DATABASE_URL` para esse container e guarda
o endereco antigo do Supabase comentado logo acima das duas linhas: enquanto o Supabase estiver em
somente-leitura, a API, as migrations e os scripts de carga falam com o canonico local sem nenhum
override de shell (o `load_canonical_batch.py`, alias, le o canonico sempre de
`DIRECT_DATABASE_URL`/`DATABASE_URL`, entao nao ha flag para troca-lo). Para voltar ao Supabase,
descomente as duas linhas comentadas e comente as locais.

Os testes de integracao de auth/RBAC usam **PostgreSQL descartavel**: as migrations rodam num schema
temporario (`search_path`) que e removido no fim, entao o banco escolhido nao e alterado.

```powershell
docker exec voa-staging createdb -U postgres voa_api_test
$env:TEST_DATABASE_URL = "postgresql://postgres:SENHA@localhost:5434/voa_api_test"
npm run test:integration
```

Sem `TEST_DATABASE_URL` o bloco inteiro e ignorado, entao `npm test` permanece verde em maquina sem
banco. Os testes cobrem login (sucesso e falha auditada), cookie `voa_refresh` httpOnly,
`/auth/me`, rotacao do refresh (reuso do token antigo recebe 401), RBAC (`viewer` recebe 403 nas
escritas), a cadeia `schools`/`customers`/`students`/`contacts`/`agreements`/`installments`/`payments`,
os `PATCH` parciais (inclusive o gate de retencao) e as rotas de migracao (registro idempotente do
lote, `validate`/`commit` com bloqueio aberto, triagem de achado) - com `GET /audit-logs` restrito ao
`admin`.

Para criar o primeiro administrador no banco local, aponte as duas variaveis (`create-admin` prefere
`DIRECT_DATABASE_URL`) e informe e-mail e senha temporarios:

```powershell
$env:DIRECT_DATABASE_URL = "postgresql://postgres:SENHA@localhost:5434/voa_staging"
$env:ADMIN_EMAIL = "admin@voa.local"
$env:ADMIN_PASSWORD = "troque-esta-senha-123"
npm run auth:create-admin
```

O login devolve o access token e o cookie `voa_refresh`; a senha temporaria deve ser trocada assim que
o operador tiver a tela de perfil.

