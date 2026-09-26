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
