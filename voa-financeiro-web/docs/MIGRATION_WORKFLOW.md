# Fluxo de migracao do legado

## Estado atual

- O workbook legado foi perfilado em modo somente leitura.
- O importador dry-run grava somente `migration_batches`, `migration_rows`, `migration_errors` e `reconciliation_reports`.
- Nenhuma escola, cliente, aluno, acordo, parcela, pagamento ou cobranca canonica e criada nesse modo.
- Senhas, API keys e tokens sao substituidos por `[REDACTED]` antes de persistir o payload.
- O lote completo `VOA.xlsx` da revisao anterior (419.700 linhas em 39 abas) esta em staging no Supabase e ja passou por validacao. A revisao de 2026-09-25 20:01 (`VOA.xlsx`, **60 abas e 546.346 linhas**) **esta estagiada e validada no Postgres local** (lote `4609c071-03c3-47fb-beff-5c3bcad6367e`), com o dicionario conferido (`0` divergencia de coluna e `1` aba vazia) e a carga canonica (fase 7) **executada e commitada no Postgres local** (104.709 linhas, lote marcado `committed`); o ensaio revelou e corrigiu um erro de ordenacao das abas que descartava 24 contatos - ver "Carga canonica local da revisao de 20:01". O mesmo commit no Supabase segue pendente porque ele entrou em somente-leitura por cota de disco - ver "Incidente de disco no staging" e "Staging local + canonico no Supabase".
- A validacao registra achados por aba/campo, marca linhas com erro e atualiza `reconciliation_reports`.
- O relatorio consolidado da ultima validacao esta em `docs/STAGING_VALIDATION_REPORT.md`.
- O dicionario da fase 2 esta em `scripts/legacy_field_map.json` (60 abas, 856 colunas, 0 sem decisao): 50 `map`, 79 `ignore`, 725 `defer` e 2 `review`.
- A comparacao entre o Canvas App legado e as planilhas esta em `docs/LEGACY_APP_SOURCE_GAPS.md`, gerada por `scripts/audit_legacy_app_sources.py` (`npm run db:audit-app-sources`): 2 tabelas lidas pela app nao tem aba (`TBL_CONSULTA` e `TBL_EMAILISTACONTATO`, deixadas fora de proposito), 2 campos de negocio faltam nas abas que existem (`CONTA_NOME`, `EMPRESA_ID`), 3 tabelas tem o conteudo em aba irma (`_FINANCEIRO`) e 5 fontes fora do Dataverse (conectores e Excel Online) nunca estiveram no workbook.
- O relatorio do dicionario esta em `docs/FIELD_MAPPING_DICTIONARY.md`, gerado por `scripts/build_field_dictionary.py`.
- A triagem das colunas `review` esta em `docs/FIELD_MAPPING_TRIAGE.md`: o que cada uma e no dado do lote, a decisao por classe (sem destino canonico, decisao ja tomada em 2026-09-25, politica de identidade, schema faltando, endereco de escola) e o impacto de cada aceite no portao. Em 2026-10-22 o operador aceitou as classes A, B, E e A': **23 colunas sairam de `review`**, a classe D foi aprovada de forma estreita (migration `0009` so com `contacts.legacy_id` e `installments.legacy_id`) e a classe A' entrou como `status: "proposed"`. Em 2026-10-27 a `0010` fechou o schema da classe D e a `0011` reabriu a classe C com a entidade `guardians`, alem de mapear `TBL_ENDTEL` -> `student_contacts`: restam **2** colunas em `review` (`Pagamento_DataFechamento` e `TBL_USER.ID`).
- A carga canonica (fase 7) esta em `scripts/load_canonical_batch.py`, com dry-run por padrao. Em 2026-09-25 ela carregou 78.217 linhas de `schools`, `customers`, `contacts` e `students` e, na mesma data, a cadeia financeira (`agreements`, `installments`, `payments`, `asaas_customers` e o cliente pagador sintetizado) com `agreements.total_amount` fechando exatamente com a soma de `installments.original_amount`; o relatorio da ultima rodada esta em `docs/CANONICAL_LOAD_REPORT.md`. Os 22 mapeamentos `proposed` de entao foram confirmados pelo operador em 2026-09-25; desde 2026-10-22 existe **um** `proposed` novo (`Pagamento_Nome -> agreements.reference`) e desde 2026-10-27 mais **dez** (`guardians` e `student_contacts`, abertos pela `0011`), entao a carga completa precisa de `--allow-proposed agreements,guardians,student_contacts` (sem as flags `agreements` fica bloqueado por `mapping_not_confirmed` e `installments`/`payments` caem por dependencia; `guardians` e `student_contacts` simplesmente nao carregam) ate esses mapeamentos virarem `confirmed`.
- O profiler esta em `scripts/profile_legacy_workbook.py`.
- O importador de staging esta em `scripts/stage_legacy_workbook.py`.
- O validador de staging esta em `scripts/validate_staging_batch.py`.
- Dependencias Python dos scripts: `scripts/requirements.txt` (openpyxl e psycopg 3).
- Fontes antigas permanecem em `_legacy-powerapps/`.
- O gate do lote e a triagem de achados tambem estao na API (`/api/v1/migrations/...`, contrato em `docs/API_ROUTES.md`): `validate` e `commit` recalculam o gate sobre o staging e selam o lote, mas nao estagiam, nao validam e nao carregam nada - as fases continuam sendo as dos scripts abaixo.

## Fases obrigatorias

1. **Perfil** (concluido): contar registros, colunas, vazios, duplicidades e campos sensiveis.
2. **Dicionario** (concluido com pendencias): cada coluna legada recebe decisao explicita (`map`, `ignore`, `defer` ou `review`) em `scripts/legacy_field_map.json`, com tipo, normalizacao e motivo. As colunas `review` bloqueiam a aprovacao do lote; os mapeamentos `proposed` bloqueiam ate serem confirmados (em 2026-09-25 o operador confirmou os 22 mapeamentos e agregados que estavam `proposed`, o que derrubou o gate de 55 para 37 itens; a migracao `0008` deixou 31 e a triagem de 2026-10-22, com as classes A, B, E e a `0009`, deixou 6).
3. **Staging** (concluido para `VOA.xlsx`): carregar cada linha com origem, aba, ID legado, hash e lote de importacao.
4. **Validacao** (concluido para `VOA.xlsx`): verificar chaves estrangeiras, documentos, nomes, datas, valores e registros sem relacionamento.
5. **Reconciliacao** (em andamento): gerar candidatos de duplicidade e comparar contagens/totais com o workbook.
6. **Aprovacao**: revisar conflitos e mapear excecoes sem apagar a origem.
7. **Carga canonica** (parcial em 2026-09-25): `schools`, `customers` (incluindo os 1.568 clientes pagadores sintetizados de `TBL_PAGAMENTO`), `contacts`, `students`, `agreements`, `installments`, `payments` e `asaas_customers` criados com UUIDs novos ou deterministicos e chave legada preservada. `asaas_charges` (sem `asaas_customer_id`, `environment`, `billing_type`, `due_date`, `status`, `value`) e `users` seguem bloqueados ate a decisao dos itens de politica.
8. **Cutover**: executar carga final/delta, operar em paralelo e manter rollback.


## Regras de seguranca

- Nunca importar senhas, API keys, tokens ou credenciais encontradas em planilhas/exportacoes.
- Nunca gravar o workbook inteiro no banco operacional como JSON sem dicionario.
- Nunca resolver duplicidade por exclusao automatica.
- Nunca usar nome como chave unica absoluta para pessoa.
- Toda carga deve ser repetivel por lote e ter checkpoint.
- Toda divergencia deve aparecer em relatorio antes do commit canonico.

## Comando de perfil

A partir da raiz do novo projeto:

```powershell
python scripts/profile_legacy_workbook.py ..\_legacy-powerapps\root-exports\VOA.xlsx
```

O comando imprime somente metadados estatisticos. Valores de colunas sensiveis sao omitidos.

## Comando de staging dry-run

A partir da raiz do novo projeto:

```powershell
python scripts/stage_legacy_workbook.py --preview
python scripts/stage_legacy_workbook.py
```

`--preview` le o Excel e nao grava no banco. Sem essa flag, o script cria um lote de staging idempotente pela hash do arquivo. Se o mesmo workbook ja tiver sido carregado com sucesso, o lote existente e reutilizado.

## Comando de validacao do staging

A partir da raiz do novo projeto:

```powershell
npm run db:validate-staging-dry-run
npm run db:validate-staging -- --report docs/STAGING_VALIDATION_REPORT.md --json-out "$env:TEMP\voa_validation.json"
```

`--json-out` grava o resultado em UTF-8 direto no arquivo (use em vez de `>`; ver secao de encoding abaixo).

O validador le somente `migration_rows` do lote indicado (`--batch-id` ou `--source-name`) e grava somente:

- `migration_errors` com o prefixo `details->>'validator' = 'validate_staging_batch'` (execucoes anteriores do validador sao substituidas);
- `reconciliation_reports` (contagens, duplicidades, bloqueios e totais por aba);
- `migration_rows.status = 'error'` apenas nas linhas com achado bloqueante ou de erro.

Regras verificadas: chave estrangeira legada declarada por coluna, campos obrigatorios, CPF/CNPJ (digitos verificadores), documentos duplicados, datas, valores monetarios, chaves compostas (`agreement + installment_number` e chave natural do item de divida) e deteccao de encoding legado CP850. Nenhuma tabela canonica e escrita e o lote so muda para `validated` quando nao existe achado bloqueante nem erro.

## Comando do dicionario de campos (fase 2)

A partir da raiz do novo projeto:

```powershell
npm run db:field-dictionary
npm run db:field-dictionary-check
```

`db:field-dictionary` le os cabecalhos do workbook e o schema real em `apps/api/migrations/*.sql`, resolve cada coluna pelo dicionario e regrava `docs/FIELD_MAPPING_DICTIONARY.md`. Nada e escrito no banco.

`db:field-dictionary-check` acrescenta `--from-staging --gate approved`: compara as colunas do workbook com o payload gravado no lote e falha enquanto existir coluna `review` ou mapeamento `proposed`.

Opcoes uteis:

```powershell
python scripts/build_field_dictionary.py --from-staging --json-out "$env:TEMP\voa_field_map.json"
python scripts/build_field_dictionary.py --gate approved
python scripts/build_field_dictionary.py --map caminho\outro_dicionario.json --no-report
```

Codigos de saida: `0` ok, `1` problema estrutural no dicionario (destino inexistente, decisao duplicada, coluna sem decisao), `2` aprovacao bloqueada por pendencia de politica, `3` divergencia entre as colunas do workbook e o staging.

### Como o dicionario e interpretado

- `map`: coluna vira campo canonico. Exige `type`, aceita `normalization`, `required`, `priority`, `ref`, `values` e `status`.
- `ignore`: coluna nao migra, com motivo do vocabulario fechado em `reason_codes`.
- `defer`: coluna fica apenas no payload de staging nesta fase, tambem com motivo registrado.
- `review`: depende de decisao de negocio; bloqueia a aprovacao do lote.
- `status: "proposed"` marca mapeamento ainda nao confirmado (tambem bloqueia). Desde 2026-10-27 **nenhuma** regra esta `proposed`: as 11 ultimas (`Pagamento_Nome`, 5 de `guardians` e 5 de `student_contacts`) foram confirmadas pelo operador.
- `provides_legacy_id_for`: define qual aba e a origem de `legacy_id` de cada tabela canonica. Duas abas disputando a mesma tabela geram o aviso `MULTIPLE_LEGACY_ID_PROVIDERS` no relatorio do dicionario (a provenance canonica e por aba, em `(legacy_source, legacy_table, legacy_id)`, entao varias abas podem alimentar a mesma tabela); `agreements` e provido por `TBL_PAGAMENTO` e `customers` por `TBL_CLIENTE` e `TBL_PAGAMENTO` (pagador sintetizado).
- `schema_gaps`: lista de migrations necessarias (ex.: `installments_legacy_id`, `agreements_source_resolution`), referenciada coluna a coluna.
- `links`: quando duas tabelas canonicas saem da mesma linha legada, `links` declara a coluna estrangeira e de qual tabela da mesma linha ela recebe o UUID (ex.: `payments.installment_id` vem de `row:installments` em `TBL_PAGAMENTO_LISTAGEM`, e `agreements.customer_id` vem de `row:customers` em `TBL_PAGAMENTO`).
- `const`: literal escrito pelo loader quando a coluna de origem tem valor. Serve para registrar no dicionario uma decisao que vale para todas as linhas em vez de fixa-la no codigo (ex.: `asaas_customers.environment = "production"` em `Pagamento_CliAsaas_ID`).
- `aggregates`: bloco de aba que deriva colunas de outra aba. Declara `source_sheet` (aba lida), `row_table` (tabela da linha de origem), `group_by` (coluna de agrupamento), `unique_by` (mapa coluna da origem -> coluna da tabela da linha, espelhando a `UNIQUE` do filho) e `targets` (coluna canonica -> `op` `sum`/`count`, `measure`, `normalization`, `status`). Um alvo sem valor disponivel descarta a linha pai como `LOAD_AGGREGATE_MISSING`. Ex.: `agreements.total_amount` e `agreements.installments_count` vem da soma/contagem de `TBL_PAGAMENTO_LISTAGEM` por acordo.

## Comando de carga canonica (fase 7)

A partir da raiz do novo projeto:

```powershell
npm run db:load-canonical
npm run db:load-canonical -- --json-out "$env:TEMP\voa_load_dry.json"
npm run db:load-canonical-commit
```

`scripts/load_canonical_batch.py` le o lote de staging, resolve o dicionario e grava as tabelas canonicas. Regras:

1. nada e inferido: uma tabela so carrega quando toda coluna canonica `not null` sem `default` esta coberta por um `map` (ou por um `links`) e quando as tabelas das quais ela depende ja foram carregadas;
2. `--commit` e obrigatorio para escrever; sem ele o comando e um dry-run que calcula exatamente o mesmo plano, as mesmas contagens e os mesmos achados;
3. nenhuma linha e fundida, renomeada ou apagada: a linha que o mapeamento nao satisfaz e descartada, contabilizada e reportada, e o payload de staging permanece intacto;
4. idempotencia: tabelas com `legacy_source`/`legacy_table`/`legacy_id` reutilizam o UUID existente; tabelas sem essas colunas (`contacts`, `installments`) recebem um UUID deterministico derivado da linha de origem, entao rodar de novo nao duplica nada;
5. mapeamento `status: "proposed"` so carrega com `--allow-proposed <tabela>` explicito do operador, e a aprovacao fica registrada em `reconciliation_reports.notes`. Hoje a flag e so uma rede de seguranca: nenhuma coluna do dicionario esta `proposed`, e passar `--allow-proposed` nao muda nada;
6. `--entities`, `--batch-id`, `--max-rows-per-sheet` e `--exclude-error-rows` existem para escopo, lote e ensaio controlado; `--set-batch-status` (so com `--commit`) muda o status do lote;
7. chaves `UNIQUE` declaradas nas migrations viram um indice em memoria: a linha que repetiria uma chave ja gravada (ex.: `installments (agreement_id, installment_number)`) e descartada como `LOAD_DUPLICATE_ROW` **antes** de chegar ao banco, e o mesmo resultado aparece no dry-run e no `--commit`;
8. cada `INSERT` roda dentro de um `SAVEPOINT`: violacao de `CHECK`, de `UNIQUE` parcial ou de chave estrangeira derruba apenas aquela linha (`LOAD_ROW_REJECTED`, com a mensagem do banco) e a transacao continua valida para as demais. Antes disso, uma unica linha invalida abortava a carga inteira.

O que a carga grava no banco:

- linhas canonicas com UUID novo (ou deterministico) e a chave legada preservada;
- `migration_rows.status = 'committed'` apenas nas linhas efetivamente carregadas;
- `migration_errors` com prefixo `LOAD_*` (execucoes anteriores da carga sao substituidas, os achados do validador permanecem);
- `reconciliation_reports` por tabela canonica (`entity_name` = tabela), com contagens, totais monetarios e observacoes da carga.

Codigos de saida: `0` carregou tudo que foi pedido, `1` problema estrutural no dicionario/plano, `3` lote de staging ausente, `4` carga parcial (alguma entidade pedida continua bloqueada).

O relatorio da ultima rodada fica em `docs/CANONICAL_LOAD_REPORT.md`.

## Gate e triagem pela API (2026-10-22)

O staging e selado por `/api/v1/migrations` sem duplicar nenhuma fase. A rota **nao** le o workbook,
nao roda o validador e nao escreve tabela canonica: ela confere o que os scripts ja gravaram.

| Passo | Rota | Efeito |
|---|---|---|
| registrar a fonte | `POST /api/v1/migrations/batches` | cria o lote em `profiled`, idempotente por `source_name` + sha256 do arquivo |
| acompanhar | `GET /api/v1/migrations/batches/:id` | linhas por status, achados por severidade, reconciliacao e os dois vereditos do gate |
| triar | `GET /api/v1/migrations/batches/:id/errors`, `POST /api/v1/migrations/errors/:id/resolve` | grava `resolved_at` e a nota em `details.resolution` (o achado continua no banco) |
| selar validacao | `POST /api/v1/migrations/batches/:id/validate` | `profiled`/`staging`/`validated`/`approved` -> `validated` |
| selar carga | `POST /api/v1/migrations/batches/:id/commit` | `validated`/`approved` -> `committed` e `completed_at = now()` |

O gate reprova com `409 BATCH_NOT_READY` e a lista de `blockers` quando: o lote nao tem linha
(`NO_ROWS`), alguma linha esta `error` (`ROWS_IN_ERROR`), existe achado `blocking` ou `error` sem
`resolved_at` (`OPEN_BLOCKING_FINDINGS`, `OPEN_ERROR_FINDINGS`) ou, so no `commit`, o lote nao tem
`reconciliation_reports` (`NO_RECONCILIATION`). `warning` nao bloqueia. Lote `committed`,
`rolled_back` ou `failed` responde `409 INVALID_STATUS` - o gate nao reabre lote encerrado, entao o
lote local `4609c071-03c3-47fb-beff-5c3bcad6367e` (ja `committed` desde 2026-09-26) so muda por
script, de proposito.

Resolver um achado nao mexe na linha do staging: a linha marcada `error` continua bloqueando ate ser
corrigida na origem e reestagiada. Quem consome o lote e a carga canonica (`npm run
db:load-canonical-commit`), que valida o status por conta propria; o `commit` da API fecha a janela e
registra `migration.batch.committed` em `audit_logs`, nada mais.

## Pre-condicoes da carga canonica

Antes de aprovar o lote e rodar a carga com UUIDs novos:

1. `python scripts/build_field_dictionary.py --from-staging` sai com codigo `0` (nenhuma coluna sem decisao, nenhum destino inexistente e nenhuma divergencia de coluna entre workbook e staging).
2. `python scripts/build_field_dictionary.py --gate approved` sai com codigo `0`: nao existe coluna `review` nem mapeamento `status: "proposed"`. Hoje ele sai com codigo `2` e 2 pendencias (`REVIEW_REQUIRED` em `Pagamento_DataFechamento` e `TBL_USER.ID`); nenhum `MAPPING_NOT_CONFIRMED` desde 2026-10-27.
3. `migration_batches.status` do lote e alterado para aprovado somente depois do item 2.
4. O banco canonico nao contem linhas de teste. Em 2026-09-24 existiam `schools` = 1 (legal_name `Escola Teste`) e `customers` = 1 (full_name `Ian`), ambas sem `legacy_source`/`legacy_table`/`legacy_id` e anteriores ao lote de staging; elas nao existem mais no banco local (medicao de 2026-10-27: `0` linhas sem `legacy_source` em `schools`, `customers`, `agreements` e `users`), e no Supabase as 3 linhas sem proveniencia devem ser removidas ou isoladas para nao poluir a reconciliacao:
5. Senhas, tokens e API keys nao sao migrados; `TBL_BANCO.BANCO_APIKEY`, `TBL_USER.USER_SENHA` e `TBL_USER.USER_PASS` estao marcados como `secret_revoked` no dicionario.

## Resultado da carga canonica de 2026-09-25 (fase 7, parcial)

Lote `VOA.xlsx` (`5cd769e4-eaaa-49bd-b5ba-7e03947e5e09`), fonte `powerapps-voa`, executado com `--commit --allow-proposed contacts`.

| Tabela | Linhas legadas | Carregadas | Descartadas |
|---|---:|---:|---:|
| `schools` (`TBL_ESCOLA`) | 75 | 75 | 0 |
| `customers` (`TBL_CLIENTE`) | 24.696 | 24.696 | 0 |
| `contacts` (`TBL_CLIENTEENDTEL`) | 54.782 | 46.805 | 7.977 |
| `students` (`TBL_ALUNO`) | 6.652 | 6.641 | 11 |
| total | 86.205 | 78.217 | 7.988 |

Achados registrados em `migration_errors` (prefixo `LOAD_*`):

- `LOAD_REFERENCE_UNRESOLVED` `CLIENTEENDTEL_CLIENTE_ID`: 7.672 linhas apontam para um cliente que nao existe em `TBL_CLIENTE`;
- `LOAD_REQUIRED_FIELD_EMPTY` `CLIENTEENDTEL_VALOR`: 300 linhas sem telefone/e-mail; `CLIENTEENDTEL_CLIENTE_ID`: 5 linhas sem cliente;
- `LOAD_REQUIRED_FIELD_EMPTY` `Aluno.Nome`: 10 linhas sem nome; `LOAD_REFERENCE_UNRESOLVED` `Aluno.Escola.ID`: 1 linha apontando para escola inexistente (`16`);
- `LOAD_VALUE_DEFAULTED` `Aluno_Ativo`: 114 linhas sem status usaram o `default` canonico `active` (o vazio nunca vira `inactive`).

A segunda execucao do mesmo lote em dry-run reporta 78.217 linhas **reutilizadas** e 0 inseridas, o que comprova a idempotencia da carga.

## Resultado da cadeia financeira de 2026-09-25 (fase 7, agreements -> installments -> payments)

Mesmo lote (`5cd769e4-eaaa-49bd-b5ba-7e03947e5e09`), fonte `powerapps-voa`, executado com:

```powershell
python scripts\load_canonical_batch.py --entities schools,students,customers,agreements,asaas_customers,installments,payments,asaas_charges --allow-proposed agreements,installments,payments,asaas_customers,customers --commit --json-out "$env:TEMP\voa_commit.json"
```

O que foi decidido antes da carga, e que agora esta registrado no dicionario:

- **o cliente pagador e sintetizado.** `TBL_CLIENTE` e registro institucional (CNPJ, CNAE, INEP) e nenhuma ponte por e-mail, telefone, nome ou CNPJ fechou com as 1.572 linhas de `TBL_PAGAMENTO`; `TBL_PAGAMENTO` nao tem coluna de cliente (so `Escola_ID`, `Aluno_ID`, `Nome_Aluno`, `CliAsaas_ID`). A decisao do operador foi manter a cobranca e derivar o cliente da propria linha do acordo: `customers.legacy_id = Pagamento.ID`, `customers.full_name = Pagamento.Nome_Aluno` (`links: agreements.customer_id = row:customers`);
- **`asaas_customers`** sai da mesma linha: `external_id = Pagamento.CliAsaas_ID` e `environment = "production"` por `const` (o id nao revela o ambiente; o operador confirmou producao);
- **`agreements.total_amount` e `agreements.installments_count`** sao derivados (`aggregates`) de `TBL_PAGAMENTO_LISTAGEM`, agrupados por `Pagamento_Listagem.Pagamento.ID` e deduplicados por `(acordo, parcela)` exatamente como a `UNIQUE (agreement_id, installment_number)` de `installments`;
- **`payments`** so nasce com valor pago > 0 (`min_positive`) e **`installments.installment_number`** usa `positive_integer` porque a `CHECK (> 0)` do schema trata 0/negativo como lixo.

| Tabela | Linhas legadas | Carregadas | Descartadas | Motivos de descarte |
|---|---:|---:|---:|---|
| `customers` (`TBL_CLIENTE` + `TBL_PAGAMENTO`) | 26.268 | 26.264 (24.696 reutilizadas + 1.568 novas) | 4 | 4 sem `Nome_Aluno` |
| `agreements` (`TBL_PAGAMENTO`) | 1.572 | 1.505 | 67 | 63 sem parcela na origem + 4 sem cliente |
| `installments` (`TBL_PAGAMENTO_LISTAGEM`) | 15.535 | 15.259 | 276 | 263 duplicadas de `(acordo, parcela)` + 6 sem acordo + 2 com acordo inexistente + 5 com parcela 0/negativa |
| `payments` (`TBL_PAGAMENTO_LISTAGEM`) | 15.535 | 7.016 | 8.519 | 8.243 sem valor pago > 0 + 276 sem parcela criada |
| `asaas_customers` (`TBL_PAGAMENTO`) | 1.572 | 1.120 | 452 | 446 sem `CliAsaas_ID` + 4 sem cliente + 2 `external_id` repetido |

Reconciliacao em `reconciliation_reports` (fonte = staging, canonico = banco): `agreements` 7.161.716,00 = 7.161.716,00; `installments` 7.161.716,00 = 7.161.716,00; `payments` 4.519.570,08 = 4.519.570,08. Ou seja, o total derivado dos acordos fecha **exatamente** com a soma das parcelas gravadas, e uma segunda execucao do mesmo comando reporta 57.880 linhas reutilizadas e 0 inseridas.

Pendencias desta cadeia:

- o acordo `legacy_id = 1704` tem uma unica parcela com numero 0/negativo: o filho canonico nao tem parcela e a `CHECK (installments_count > 0)` impede gravar `installments_count = 0`, entao a linha segue com o total derivado da origem (1.362,48) e aparece na comparacao com o filho. Decisao do operador: manter (escolhendo um `installments_count` minimo), apagar a linha ou afrouxar a `CHECK` numa migration;
- 5 parcelas de 0/negativo foram descartadas por `positive_integer` (linhas que antes eram recusadas pelo banco como `LOAD_ROW_REJECTED`);
- os 4 acordos com total derivado ajustado (`38`, `39`, `41`, `1663`) foram corrigidos a partir do filho canonico (parcela de numero 0/negativo removida da contagem e do total);
- `asaas_charges` continua bloqueada: faltam `asaas_customer_id`, `environment`, `billing_type`, `due_date`, `status` e `value`.

## Proposta de mapa de status de cobranca e repasse (2026-09-25)

Levantamento feito direto no staging do lote `5cd769e4-eaaa-49bd-b5ba-7e03947e5e09` (aba
`TBL_PAGAMENTO_LISTAGEM`, 15.535 linhas) com uma sonda somente-leitura que faz
`DISTINCT payload->>'<coluna>'`. As duas colunas que o dicionario marca como
`review: status_map_unconfirmed` tem, na pratica, **9** e **5** valores (nao 8 e 5):

### `Pagamento_Banco_Status` -> `asaas_charges.status`

| Rotulo legado | Linhas | Valor canonico proposto | Observacao |
|---|---:|---|---|
| (vazio) | 4.799 | `unknown` | a origem nao afirma status; virar `pending` seria inventar dado |
| `BAIXADO` | 4.175 | `paid` | baixa lancada a partir do extrato |
| `PAGO AUTOMATICO` | 3.250 | `paid` | baixa automatica |
| `ATRASADO` | 1.240 | `overdue` | |
| `PENDENTE` | 1.127 | `pending` | |
| `PAGO COLEGIO` | 439 | `paid` | |
| `PAGAMENTO MANUAL` | 353 | `paid` | |
| `CARTAO ITAU` | 151 | `paid` | unico caso de cartao; ver decisao de `billing_type` |
| `z` | 1 | nao mapeado | lixo de digitacao: cai no `DEFAULT 'unknown'` e sai como `LOAD_VALUE_DEFAULTED` (1 linha, nao bloqueia o lote) |

Os 8 rotulos de negocio colapsam em 4 valores canonicos (`paid`, `pending`, `overdue` e o
`unknown` do vazio e do `z`). O vazio e o `z` **nao** entram em `values`: os dois caem no
`DEFAULT 'unknown'` criado na `asaas_charges.status` pela migration 0008 e sao reportados como
`LOAD_VALUE_DEFAULTED` em vez de derrubar a linha.

### `Pagamento_Lista.Status` (repasse) -> `payments.retention_status`

| Rotulo legado | Linhas | Valor canonico proposto |
|---|---:|---|
| `AGUARDANDO APROVAÇÃO` | 7.524 | `pending_approval` |
| `REPASSE REALIZADO` | 6.993 | `released` |
| `NÃO EXISTE REPASSE` | 744 | `not_applicable` |
| `PAGAMENTO DIRETO` | 176 | `direct_payment` |
| `REPASSE APROVADO` | 98 | `approved` |

Aqui o mapa cobre 100% da coluna: os 15.535 valores estao preenchidos, sem residuo.

### Aplicado na migration 0008 (2026-10-09)

O bloco inteiro foi aplicado na `apps/api/migrations/0008_payments_retention_and_charge_status.sql`
(o `0007` passou a ser dos tokens de refresh, entao o numero foi remanejado):

1. `ALTER TABLE asaas_charges ALTER COLUMN status SET DEFAULT 'unknown';` — com o `DEFAULT`, as
   4.799 linhas vazias (e o `z`) deixam de ser um `INSERT` incompleto e passam a sair como
   `LOAD_VALUE_DEFAULTED`, rastreado no relatorio de carga;
2. o bloco de retencao:

| Coluna legada | Preenchidas | Coluna canonica | Coluna criada |
|---|---:|---|---|
| `Pagamento_Lista.Status` | 15.535 | `payments.retention_status` | com CHECK dos 5 rotulos |
| `Pagamento_Lista.DataAprovacao` | 7.091 (2020-11-09 a 2026-03-30) | `payments.retention_approved_at` | `date` |
| `Pagamento_Lista.MesAnoProgramacaoRepasse` | 7.087 (`MM AAAA`) | `payments.retention_scheduled_month` | `text` com CHECK `AAAA-MM` |
| `Pagamento_Lista.MesAnoRepasseRealizado` | 6.875 (2020-12-07 a 2026-03-06) | `payments.retention_released_at` | `date` |
| `Pagamento_Lista.PorcentagemAcordo` | 7.080 (0 a 0,35) | `payments.retention_percentage` | `numeric(5, 4)` com CHECK de 0 a 1 |
| `Pagamento_Lista.ValorRetido` | 7.091 | `payments.retained_amount` | ja existia desde a 0005 |

3. as 5 colunas de retencao e o status de cobranca viraram `map` + `status: confirmed` no
   dicionario: as pendencias `status_map_unconfirmed`, `semantics_unclear` e `schema_gap_pending`
   e as lacunas `payments_retention_approval`/`payments_charge_status` sairam do gate (`review`
   caiu de 37 para 31).

#### O que o loader precisou aprender

- `ALTER TABLE ... ALTER COLUMN ... SET DEFAULT` passou a ser lido como o `DEFAULT` do
  `CREATE TABLE`: e o que tira a coluna `NOT NULL` de `required_columns` e entrega o fallback
  rastreavel;
- normalizacao `fraction`: aceita virgula decimal e ruido de float (`0,25000001` -> `0.2500`) e
  **recusa** o que sai de 0..1 (um valor fora da faixa violaria o CHECK e abortaria a transacao);
- normalizacao `month_year`: `09 2024` -> `2024-09`;
- `--enrich-reused` (so com `--commit`): uma linha reusada pela chave legada nao era atualizada, e
  a coluna nova ficaria vazia para sempre. O passo faz
  `UPDATE ... SET col = COALESCE(col, %s) WHERE id = %s AND (col IS NULL)`, entao o valor gravado
  sempre vence e a rodada seguinte reporta `enriched=0`.

```powershell
# enriquecimento das linhas ja carregadas com as colunas novas da 0008
python scripts\load_canonical_batch.py --commit --enrich-reused `
  --staging-url $env:DIRECT_DATABASE_URL --set-batch-status committed
```

Resultado no canonico local: `payments.retention_status` em **7.016 de 7.016** linhas,
`retention_percentage` 6.882 (0,0000 a 0,3500, 61 valores distintos), `retention_approved_at` 6.893,
`retention_scheduled_month` 6.889 e `retention_released_at` 6.678 — os intervalos previstos acima,
sem nenhum pagamento com `retained_amount > 0` e `retention_percentage` nulo. A segunda rodada
reportou `enriched=0` (idempotencia real). Unico achado novo: 1 linha com
`Pagamento_Lista.MesAnoProgramacaoRepasse = '10'`, descartada como `LOAD_MONTH_YEAR_UNPARSEABLE`
(achados de 20 para 21, nenhum bloqueio novo).

`payments.released_amount` continua 0,00 para todas as linhas: o legado nao tem coluna de valor
liberado (a 0005 criou a coluna para o fluxo novo da API). O que o legado registra e o estado
(`retention_status = 'released'`, 6.796 linhas) e a data (`retention_released_at`).

### Aplicado na migration 0009 (2026-10-22)

As duas lacunas de rastreabilidade que sobravam da triagem (`docs/FIELD_MAPPING_TRIAGE.md`,
classes D) sairam com a `apps/api/migrations/0009_contacts_installments_legacy_provenance.sql`:

| Tabela | Origem | Linhas carregadas | Colunas criadas |
|---|---|---:|---|
| `contacts` | `TBL_CLIENTEENDTEL` | 46.829 de 54.782 | `legacy_source`, `legacy_table`, `legacy_id` + indice unico |
| `installments` | `TBL_PAGAMENTO_LISTAGEM` | 15.259 de 15.535 | `legacy_source`, `legacy_table`, `legacy_id` + indice unico |

Quatro pontos de operacao:

1. A migration e **inerte** para a carga: `load_canonical_batch.py` so usa a chave legada quando o
   dicionario declara `provides_legacy_id_for` para a tabela. Foi o que permitiu aplicar a `0009`
   antes de mexer no mapa.
2. As linhas gravadas antes da `0009` estavam enderecadas pelo UUID deterministico
   (`uuid5("canonical-load", f"{aba}:{linha}")`). `scripts/backfill_legacy_provenance.py`
   (`npm run db:backfill-legacy-provenance`) recalcula esse UUID e carimba a chave legada:
   `46.829` contatos e `15.259` parcelas carimbados, `0` divergencias, `0` a carimbar na segunda
   rodada. Linhas que a carga pulou aparecem como `missing` (7.953 contatos e 276 parcelas).
3. So depois do backfill as colunas `ID` das duas abas viraram `map` com `provides_legacy_id_for`.
   Na ordem inversa a carga tentaria reinserir as linhas existentes e o banco recusaria pela chave
   natural (`installments` por `(agreement_id, installment_number)`).
4. O backfill confere a `0009` **no banco conectado**, e nao apenas nos arquivos de migration: ele
   consulta `information_schema.columns` no `current_schemas(false)` e, se as colunas (ou a tabela)
   nao existirem, sai com `exit 3` e um erro acionavel:

   ```json
   {"ok": false, "error": "contacts: colunas ausentes no banco ['legacy_source', 'legacy_table', 'legacy_id']; rode `npm run db:migrate` (migration 0009) antes do backfill"}
   ```

   Sem essa checagem o erro seria um `UndefinedColumn` do psycopg no meio da primeira tabela.
   Verificado nos dois modos (tabela ausente e tabela sem as colunas) contra um banco descartavel.

Validacao: `python scripts\load_canonical_batch.py` (dry-run) reusou as `104.709` linhas
(`inserted=0`, `reused=104.709`) e `canonical_before == canonical_after` em todas as tabelas;
o dicionario ficou em `38 map`, `78 ignore`, `734 defer`, `6 review` (`0` problema estrutural e
`0` divergencia de staging - as contagens de hoje, depois da classe A', estao na secao seguinte) e a
suite Python foi para `204` testes (as `6` novas cobrem a checagem do schema vivo). As migrations
tambem foram aplicadas do zero: `npm run test:integration` com `TEST_DATABASE_URL` roda
`applyMigrations` num schema temporario e passou com `21` testes, e `npm run db:migrate` no banco
existente reporta `0 aplicadas, 9 ja aplicadas`.

### Aplicado em 2026-10-22 e confirmado em 2026-10-27: classe A'

`TBL_PAGAMENTO.Pagamento_Nome` (`Acordo 2024`=438, `Acordo 2023`=557, `Acordo 2025`=186; 73 rotulos em
1.570 linhas) passou a `map: agreements.reference` - era a unica coluna da triagem com semantica
comprovada **e** destino livre no schema (`agreements.reference` existia e nenhuma coluna escrevia
nela). Em 2026-10-22 entrou como `status: "proposed"`; depois da validacao da coluna em tela, o
operador confirmou em 2026-10-27 (`status: "confirmed"`), o que tirou o `MAPPING_NOT_CONFIRMED` do
portao e devolveu a cadeia financeira a rodada padrao.

Efeito medido na carga (dry-run do mesmo lote `4609c071`, ainda em 2026-10-22):

| Rodada | Entidades prontas | Linhas reusadas |
|---|---:|---:|
| sem `--allow-proposed` | 5 (`schools`, `customers`, `contacts`, `students`, `asaas_customers`) | 80.929 |
| com `--allow-proposed agreements` | 8 (acima + `agreements`, `installments`, `payments`) | 104.709 |

Naquele momento, sem a flag, `agreements` ficava com `mapping_not_confirmed (reference)` e
`installments`/`payments` caiam por `dependency_not_loaded`. Hoje isso nao acontece mais: a rodada
padrao e a rodada completa (ver a secao da `0011`). Em nenhuma das rodadas houve insercao
(`inserted=0`): a proposta nao muda dado ate alguem rodar `--commit --enrich-reused`, quando
`agreements.reference` e preenchida pelo `COALESCE` do enriquecimento (nunca sobrescreve valor
existente) - as 1.505 linhas locais seguem com `reference` nula porque sao reusadas pela chave
legada; num banco novo, como o Supabase, o valor entra na insercao.

### Aplicado na migration 0010 (2026-10-27)

As tres lacunas de schema que sobravam da classe D da triagem
(`docs/FIELD_MAPPING_TRIAGE.md`) sairam com a
`apps/api/migrations/0010_class_d_schema_gaps.sql`:

| Origem | Linhas | Objeto criado | Por que |
|---|---:|---|---|
| `TBL_PAGAMENTO.Pagamento_DataFechamento` | 1.497 de 1.572 preenchidos | `agreements.closed_at timestamptz` (nullable) + indice parcial | `agreements` nao tinha data de fechamento nem de assinatura |
| `TBL_ENDTEL` | 47.562 linhas, 6.894 alunos | tabela `student_contacts` (espelho de `contacts` com `student_id`, proveniencia legada e chave unica `(legacy_source, legacy_table, legacy_id)`) | `contacts.customer_id` e `NOT NULL` e o contato pertence ao aluno, nao ao cliente pagador |
| `TBL_USER.ID` | 28 usuarios | `users.legacy_source/legacy_table/legacy_id` + `users_legacy_key_idx` | sem chave legada nao ha como casar a conta canonica com a linha do PowerApps |

Tres pontos de operacao:

1. A `0010` e **inerte para a carga**, igual a `0009`: nenhuma coluna do dicionario aponta para os
   objetos novos. A rodada `--allow-proposed agreements` continuou com `considered=121.991`,
   `loaded=104.709`, `inserted=0`, `reused=104.709` e `exit 4` (pelo `asaas_charges`), e o portao
   com `6` itens (`5 REVIEW_REQUIRED` + `1 MAPPING_NOT_CONFIRMED`). Esses numeros sao de antes da
   `0011`/da aprovacao de 2026-10-27; hoje a rodada padrao faz `176.205`/`150.018`.
2. O que mudou foi o **motivo** do bloqueio, nao a contagem: `Pagamento_DataFechamento` saiu de
   `schema_gap_pending` para `pending_policy` (fechamento do acordo x assinatura), `TBL_USER.ID`
   para `user_import_requires_credential_reset` (`password_hash` e `NOT NULL`, a senha do legado nao
   migra) e as quatro colunas de `TBL_ENDTEL` para `student_contact_load_pending` (5.988 linhas sem
   tipo nem status, e o vinculo segue a decisao de identidade da classe C). O codigo de motivo
   `student_contact_not_modeled` saiu do vocabulario junto com o gap que ele descrevia.
3. `student_contacts` **nao** recebeu chave natural `(student_id, type, value)`: o legado nao garante
   unicidade e a decisao de deduplicacao pertence a etapa de carga, nao ao schema.

Validacao: aplicacao no banco existente (`Applied migration 0010_class_d_schema_gaps.sql`, segunda
rodada sem nada a aplicar), conferencia de colunas/FK/indices no `information_schema`/`pg_indexes`,
aplicacao do zero num banco vazio (`voa_migtest`: os `10` arquivos em ordem, sem erro, banco
descartado depois), suite Python com `205` testes e dicionario em `39 map`, `78 ignore`,
`734 defer`, `5 review`, `0` problema estrutural e `0` divergencia de staging.

### Aplicado na migration 0011 (2026-10-27)

A `0011_guardians_and_student_contact_status.sql` faz o que a `0010` deixou para depois: cria a
entidade `guardians` (condicao de reabertura da classe C) e habilita a carga de `TBL_ENDTEL`.

| Origem | Linhas | Objeto criado | Por que |
|---|---:|---|---|
| `TBL_ALUNO` (`Aluno.Responsavel_Financeiro`, `Aluno.CPFResponsavel`, `Aluno_RGResponsavel`, `Aluno_ResponsavelEstadoCivil`, `Aluno_ResponsavelProfissao`) | 6.350 com nome, 6.651 com CPF, 621/585/585 com os demais | tabela `guardians` (filha de `students`, `customer_id` nullable, `is_financial`/`is_verified`, proveniencia legada) | o responsavel nao e cliente pagador; sem entidade propria ele so poderia virar `customers`, o que a classe C proibiu |
| `TBL_ENDTEL.ENDTEL_STATUS` | 35.578 ATIVADO / 5.996 DESATIVADO | `student_contacts.status text NOT NULL DEFAULT 'active'` | a `0010` nao tinha onde guardar o status: sem a coluna, os inativos seriam descartados ou carregados como ativos |

Quatro pontos de operacao:

1. A `0011` entrou com `guardians` e `student_contacts` como `status: "proposed"` e o operador
   **confirmou as 10 colunas em 2026-10-27**, junto com `Pagamento_Nome` (classe A'). Com isso a
   rodada padrao passou a ser a rodada completa: `considered=176.205`, `loaded=150.018`,
   `inserted=0`, `reused=150.018`; o `exit 4` que sobrava era o `asaas_charges`, resolvido em
   2026-10-27 ao tirar a entidade do plano de carga (ver "Decisao sobre cobrancas do legado"), entao
   hoje a rodada sai `exit 0`. Os numeros anteriores ficam como
   referencia: `121.991`/`104.709` com `--allow-proposed agreements` e `89.349`/`80.929` sem flag
   nenhuma (quando `agreements` bloqueado derrubava `installments` e `payments`).
2. A chave legada do guardiao e a da **linha do aluno** (`legacy_id = TBL_ALUNO.ID`,
   `legacy_table = TBL_ALUNO`), porque o legado nao tem id de responsavel. E o mesmo criterio de
   `TBL_PAGAMENTO`, onde o `ID` identifica `agreements` e o cliente sintetizado: duas entidades, uma
   linha de origem. `guardians.student_id` entra por `links: row:students`, nunca por nome.
3. `student_contacts.type` ficou **sem** default sintetico. O cruzamento medido em `TBL_ENDTEL` e
   conclusivo: 41.117 linhas tem tipo e valor, 457 tem tipo com valor vazio e 5.988 estao vazias nas
   duas colunas e no status - as 5.988 "sem tipo" nao tem dado nenhum, entao um rotulo `unknown` so
   gravaria linha vazia. Na contabilidade da rodada as 8.600 linhas descartadas sao 2.798 com aluno
   fora da carga, 5.389 sem tipo e 413 sem valor.
4. O rotulo `ENDTEL_TIPO` foi auditado antes de virar `type`: 252 e-mails com `@` estao rotulados
   como `ENDERECO`/`TELEFONE` (0,6%), 13 `EMAIL` nao tem `@`, 5 `TELEFONE` tem letra e 1 tem virgula.
   O rotulo entra como veio; a correcao pertence a revisao assistida, nao ao schema.

Validacao: `Applied migration 0011_guardians_and_student_contact_status.sql` no banco existente
(segunda rodada sem nada a aplicar), colunas/FK/indices conferidos no `information_schema` e
`pg_indexes`, aplicacao do zero num banco vazio (os `11` arquivos em ordem, sem erro), suite Python
com `215` testes e dicionario em `46 map`, `79 ignore`, `731 defer`, `0 review`, `0` problema
estrutural e `0` divergencia de staging; portao em **`exit 0`** (sem `REVIEW_REQUIRED` e sem
`MAPPING_NOT_CONFIRMED`). Carga confirmada em 2026-10-27: `6.347` guardioes e `38.962` contatos de
aluno na rodada padrao (sem flag), `inserted=0`/`reused=150.018` na segunda passada e
`--commit --enrich-reused` materializando `agreements.reference` em `1.504` das `1.505` linhas.

### Decisao sobre cobrancas do legado: `asaas_charges` fica fora da carga (2026-10-27)

O bloco anterior (`billing_type = BOLETO`, `environment = production`) descrevia como carregar a
cobranca do legado. A medicao de 2026-10-27 mostrou que a carga **nao consegue** ser honesta: a aba
de parcelas (`TBL_PAGAMENTO_LISTAGEM`, origem de `installments`/`payments`) nao carrega o cliente
Asaas - `Pagamento_CliAsaas_ID` e **vazio** nela e o vinculo existe so em
`TBL_PAGAMENTO.Pagamento_CliAsaas_ID` (1.122 preenchidos). Como `asaas_charges.asaas_customer_id` e
`NOT NULL` e a tabela tambem exige `billing_type`, `environment`, `value` e `due_date`, qualquer
carga exigiria constante inventada em cinco colunas.

Decisao:

- as quatro colunas (`Pagamento_PagAsaas_ID`, `Pagamento_LinkPag`, `Pagamento_CopiaeCola`,
  `Pagamento_Banco_Status`) ficam `defer: billing_integration_not_modeled`, o `link`
  `asaas_charges.installment_id -> row:installments` foi removido e a entidade sai do plano de carga
  (era ela, e so ela, o `exit 4` da rodada padrao);
- o valor financeiro do legado continua garantido por `installments`/`payments` (valor, vencimento,
  data e status de pagamento, retencao);
- `asaas_charges` passa a ser populada pela integracao Asaas do backend, reconciliando por
  `external_id` (coluna `UNIQUE`); `environment`/`billing_type` passam a vir do payload do provedor,
  nao de uma decisao do importador. A excecao das 151 linhas `CARTAO ITAU` deixa de existir como
  problema de carga: na integracao nova o `billing_type` e o da cobranca consultada;
- `asaas_customers` continua carregando de `TBL_PAGAMENTO` (`Pagamento_CliAsaas_ID ->
  asaas_customers.external_id`, `const: production`), porque ali o dado existe.


## Incidente de disco no staging de 2026-09-25 21:33 (Supabase em somente-leitura)

O staging da revisao de 20:01 (`VOA.xlsx`, 60 abas, 546.346 linhas) foi disparado as 21:33:48 e
abortou as 21:38:18, quando o Supabase encheu o disco:

```text
psycopg.errors.DiskFull: could not write to file "base/pgsql_tmp/pgsql_tmp126096.0": No space left on device
psycopg.OperationalError: consuming input failed: server closed the connection unexpectedly
  File "scripts/stage_legacy_workbook.py", line 453, in persist_staging
```

Estado apurado depois do incidente (tudo somente leitura, nada foi apagado):

| Metrica | Valor |
|---|---:|
| `pg_database_size()` | 1.076,8 MB |
| `migration_rows` (heap / heap + indices) | 770,2 MB / 1.042,2 MB |
| Linhas em `migration_rows` | 443.736 (23.961 + 419.700 + 75) |
| Custo por linha (heap + indices) | 2,40 KB -> as 546.346 linhas da revisao nova exigem ~1,25 GB |
| Lotes em `migration_batches` | 3 (o lote novo **nao** existe) |
| `default_transaction_read_only` | `on` (quota de disco do projeto) |
| Tabelas canonicas somadas | ~35 MB (o problema e o payload de staging) |

- **a tentativa nao deixou residuo**: `persist_staging` roda em transacao unica, entao lote, linhas
  e relatorios foram desfeitos; os 3 lotes antigos seguem com as mesmas 443.736 linhas e a carga
  canonica continua ancorada em `5cd769e4-...`;
- **a escrita esta bloqueada para todos**, inclusive limpeza: `CREATE TEMP TABLE` e
  `DELETE ... WHERE false` respondem `cannot execute ... in a read-only transaction`, ou seja nao
  da para apagar lote descartavel via SQL enquanto o projeto estiver nesse modo;
- o `DiskFull` tambem derrubou a sonda de retencao que usava `sort`, por isso as contagens desta
  secao e da proposta acima vem de agregacoes leves;
- a segunda execucao do `npm run db:field-dictionary-check` (21:46) morreu no mesmo `DiskFull` ao
  ler o inventario do staging, entao `docs/FIELD_MAPPING_DICTIONARY.md` **nao** foi regerado: ele
  ficou como a execucao de 21:38 (37 itens de politica, 0 estruturais) e as 3 linhas afetadas pela
  ultima anotacao (`Pagamento_Lista.PorcentagemAcordo`, a contagem da lacuna
  `payments_retention_approval` e a lista de colunas dessa lacuna) foram alinhadas a mao com o
  mapa; a proxima execucao bem-sucedida do gerador reescreve o arquivo com o mesmo conteudo.

Caminhos para destravar (decisao do operador):

1. **liberar disco no projeto Supabase** (dashboard, Compute/Disk ou upgrade de plano) - e o unico
   caminho sem mudanca de codigo;
2. com escrita liberada: `VACUUM (FULL, ANALYZE) migration_rows`, que devolve o espaco das tuplas
   mortas da transacao abortada;
3. se o espaco continuar apertado, apagar os lotes descartaveis ja documentados como tais
   (`f1691f22-...`, 23.961 linhas, duplicata de `TBL_PAGAMENTO_FINANCEIRO`; `b0267238-...`, 75
   linhas) e, so depois da revisao nova validada, decidir sobre o lote antigo `5cd769e4-...`
   (419.700 linhas, ~880 MB) - a rastreabilidade canonica sobrevive em `legacy_id`/`legacy_table`,
   mas o payload de auditoria daquela revisao se perde;
4. **escolhido pelo operador em 2026-09-25**: estagiar e validar em Postgres local e enviar ao
   Supabase somente as tabelas canonicas (~35 MB). Isso ja esta implementado: `--staging-url` no
   `scripts/load_canonical_batch.py` e `STAGING_DATABASE_URL` no stager, no validador e no dicionario;
   o passo a passo esta em "Staging local + canonico no Supabase".

## Staging local + canonico no Supabase (caminho escolhido em 2026-09-25)

O staging da revisao nova nao cabe no disco do Supabase (~1,25 GB de payload contra ~1 GB de cota),
entao a topologia passou a ter dois bancos:

- **staging** (`STAGING_DATABASE_URL`): `migration_batches`, `migration_rows`, `migration_errors` e
  `reconciliation_reports`. Roda no Postgres local (nao consome cota e e descartavel);
- **canonico** (`DIRECT_DATABASE_URL`/`DATABASE_URL`): as tabelas de dominio no Supabase (~35 MB).

Preparo do banco local (uma vez por maquina, com o PG local ouvindo em `5433`):

```powershell
# 1. cria o banco de staging (pede a senha do usuario postgres local)
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -h localhost -p 5433 -U postgres `
  -c "CREATE DATABASE voa_staging"

# 2. aplica as migrations 0001..0006 NO LOCAL (o runner prioriza DIRECT_DATABASE_URL)
$env:DIRECT_DATABASE_URL = "postgresql://postgres:SENHA@localhost:5433/voa_staging"
$env:DATABASE_URL = $env:DIRECT_DATABASE_URL
npm run db:migrate
```

Cadeia de staging local com o canonico no Supabase:

```powershell
# o .env (Supabase) continua sendo a fonte do canonico; o staging vai por variavel de ambiente
$env:STAGING_DATABASE_URL = "postgresql://postgres:SENHA@localhost:5433/voa_staging"

python scripts\stage_legacy_workbook.py --json-out "$env:TEMP\voa_stage.json"       # grava no local
python scripts\validate_staging_batch.py --report docs\STAGING_VALIDATION_REPORT.md
python scripts\build_field_dictionary.py --from-staging --gate approved
python scripts\load_canonical_batch.py --entities schools,students,customers,contacts,agreements,asaas_customers,installments,payments --commit --json-out "$env:TEMP\voa_commit.json"
```

Como as duas conexoes funcionam:

- `stage_legacy_workbook.py`, `validate_staging_batch.py` e `build_field_dictionary.py --from-staging`
  usam `STAGING_DATABASE_URL` quando ela existe (senao `DIRECT_DATABASE_URL`/`DATABASE_URL`), atraves
  do `connect()` de `scripts/stage_legacy_workbook.py`;
- `load_canonical_batch.py` aceita **`--staging-url`** (vence a variavel de ambiente) e grava o
  canonico sempre no `DIRECT_DATABASE_URL`/`DATABASE_URL`: as leituras de `migration_rows` e as
  gravacoes de achados/reconciliacao do lote vao para o staging, e as insercoes de dominio vao para o
  Supabase. Nessa rodada o canonico commita primeiro e o staging depois (a carga e idempotente por
  `legacy_id`, entao repetir a rodada reutiliza as linhas em vez de duplicar);
- `resolve_database_urls()` decide isso em um unico lugar e esta coberto por testes
  (`DatabaseRoutingTests` em `scripts/test_load_canonical_batch.py`);
- sem `STAGING_DATABASE_URL` e sem `--staging-url` **nada muda**: as duas conexoes apontam para o
  mesmo banco e o comportamento e o historico (uma transacao, um commit);
- o relatorio da carga passa a registrar `| Staging | host:porta/banco |` e
  `| Canonico | host:porta/banco |` (sem credenciais), para deixar em qual banco a rodada leu e gravou.

Efeito colateral aceito: o `snapshot_canonical_counts` do validador passa a olhar as tabelas canonicas
do banco de staging (vazias no local). Ele existe para provar que a validacao nao toca no canonico, e a
prova continua valida - quem grava o canonico e o `load_canonical_batch.py`, com o `connect()` do
canonico.

### Resultado do staging local da revisao de 20:01 (2026-09-26)

Rodado exatamente na ordem da secao acima, com `STAGING_DATABASE_URL` no `.env`:

| Etapa | Resultado |
|---|---|
| Staging | lote `4609c071-03c3-47fb-beff-5c3bcad6367e`, `VOA.xlsx`, **546.346 linhas em 60 abas**, `localhost:5434/voa_staging`, 21 erros de carga (redacao/duplicidade de ID legado), ~3 min |
| Validacao | `docs/STAGING_VALIDATION_REPORT.md` regerado: 546.346 linhas em 57 abas com dados, 20 bloqueios, 30 erros e 22 avisos distintos, 76.936 linhas marcadas, 72 erros persistidos, 57 relatorios de reconciliacao; nenhum registro canonico criado |
| Dicionario | `--from-staging --gate approved`: 60 abas, 856 colunas, `staging_mismatches = 0`, `staging_empty_sheets = 1` (so `TBL_EMAILLISTACONTATO`, que tambem e lida pela app legada e nao tem aba real), 0 problemas estruturais e 6 pendencias `REVIEW_REQUIRED` (exit 2) |
| Dry-run da carga | `--staging-url ...` (leitura local, escrita canonica no Supabase): 121.991 linhas avaliadas, 104.709 validas, **104.685 reutilizadas** por `legacy_id` e **apenas 24 novas**, 17.282 descartadas, 20 achados, `asaas_charges` bloqueada (`required_columns_uncovered`) e exit 4 |

Leitura do dry-run, tabela a tabela (`novas` x `reutilizadas`):

| Tabela | Legadas | Carregadas | Novas | Reutilizadas | Descartadas |
|---|---:|---:|---:|---:|---:|
| `schools` | 75 | 75 | 0 | 75 | 0 |
| `customers` | 26.268 | 26.264 | 0 | 26.264 | 4 |
| `contacts` | 54.782 | 46.829 | **24** | 46.805 | 7.953 |
| `students` | 6.652 | 6.641 | 0 | 6.641 | 11 |
| `agreements` | 1.572 | 1.505 | 0 | 1.505 | 67 |
| `asaas_customers` | 1.572 | 1.120 | 0 | 1.120 | 452 |
| `installments` | 15.535 | 15.259 | 0 | 15.259 | 276 |
| `payments` | 15.535 | 7.016 | 0 | 7.016 | 8.519 |

- a reexportacao do workbook **nao mudou nenhum valor canonico**: os totais continuam fechando
  (`agreements.total_amount` 7.161.716,00 = `installments.original_amount` 7.161.716,00;
  `payments.retained_amount` 924.781,71; `payments.amount` 3.594.788,37). O unico delta sao os 24
  contatos novos de `TBL_CLIENTEENDTEL` (46.829 validos contra 46.805 antes);
- os descartes continuam explicados pelos mesmos achados de sempre
  (`LOAD_REFERENCE_UNRESOLVED` em `CLIENTEENDTEL_CLIENTE_ID`: 7.648; `LOAD_REQUIRED_FIELD_EMPTY` em
  `Pagamento_Listagem.Valor_Pago`: 8.243; `LOAD_AGGREGATE_MISSING` nos 63 acordos sem parcela).

Com o Supabase ainda em somente-leitura, o `--commit` foi executado **contra o banco local** (as duas
conexoes no mesmo container): e o ensaio completo da fase 7, sem tocar no Supabase.

### Carga canonica local da revisao de 20:01 (ensaio completo, 2026-09-26)

```powershell
# as duas conexoes no banco local: staging e canonico no mesmo container (split: false)
Remove-Item Env:DATABASE_URL,Env:STAGING_DATABASE_URL -ErrorAction SilentlyContinue
$env:DIRECT_DATABASE_URL  = "postgresql://postgres:SENHA@localhost:5434/voa_staging"
$env:STAGING_DATABASE_URL = $env:DIRECT_DATABASE_URL
python scripts\load_canonical_batch.py --commit --set-batch-status committed `
  --staging-url $env:DIRECT_DATABASE_URL `
  --report docs\CANONICAL_LOAD_REPORT.md --json-out "$env:TEMP\voa_commit.json"
```

Sempre passar `--staging-url` explicito: uma variavel de ambiente remanescente no shell ja
redirecionou a leitura do canonico numa rodada anterior (o `reused` virou 0 e o relatorio apontou o
banco errado).

| Etapa | Resultado |
|---|---|
| Roteamento | `{"staging": "localhost:5434/voa_staging", "canonical": "localhost:5434/voa_staging", "split": false}` - uma conexao, uma transacao, o caminho historico |
| Carga | `docs/CANONICAL_LOAD_REPORT.md` regerado: 121.991 linhas avaliadas, **104.709 carregadas** (24 novas + 104.685 reutilizadas), 17.282 descartadas, 20 achados, `asaas_charges` bloqueada (`required_columns_uncovered`), exit 4 |
| Lote | `4609c071-03c3-47fb-beff-5c3bcad6367e` -> `committed` (546.346 linhas) |
| Canonico local | `schools` 75, `customers` 26.264, `contacts` 46.829, `students` 6.641, `agreements` 1.505, `asaas_customers` 1.120, `installments` 15.259, `payments` 7.016 = **104.709 linhas** |
| Totais | `agreements.total_amount` 7.161.716,00 = `installments.original_amount` 7.161.716,00; `payments.amount` 3.594.788,37; `payments.retained_amount` 924.781,71 |
| Integridade | 0 contatos sem `customer_id`; o segundo `--commit` inseriu apenas as 24 linhas que faltavam e reutilizou as outras 104.685 (idempotencia provada em rodada real) |
| Enriquecimento (0008) | `--commit --enrich-reused` na revisao de 2026-10-09: `enriched=7016` (todas as linhas de `payments`), 0 novas e 0 descartes; segunda rodada `enriched=0` |

#### Correcao de ordenacao das abas encontrada pelo ensaio

O primeiro `--commit` carregou **46.805 contatos** (24 abaixo do plano) e o segundo, depois da
correcao, 46.829. Causa: `sheet_order()` ordenava as abas so pela tabela primaria
(`LOAD_ORDER` = `schools`, `customers`, `contacts`, `students`, `agreements`, ...), entao
`TBL_CLIENTEENDTEL` (`contacts`) rodava **antes** de `TBL_PAGAMENTO` (`agreements`), que tambem cria
`customers`. Os 4 clientes que existem apenas ali (`625`, `1123`, `1293`, `1505`) chegavam tarde e os
24 contatos que os referenciam eram descartados como `LOAD_REFERENCE_UNRESOLVED` (7.672 em vez de
7.648). O dry-run nao mostrava o problema porque o preload do canonico ja tinha os 26.264 clientes; num
banco vazio a perda era real. Agora `sheet_order(sheet_plan, plan)` espera **todos** os produtores de
uma tabela referenciada, com fallback para a ordem por tabela primaria quando ha ciclo, coberto por
`test_sheet_order_waits_for_every_producer_of_a_referenced_table` e
`test_sheet_order_survives_a_dependency_cycle`.

#### Ensaio local x canonico atual do Supabase

| Metrica | Supabase hoje | Ensaio local |
|---|---:|---:|
| `contacts` | 46.805 | **46.829** |
| `agreements` / `schools` | 1.506 / 76 | 1.505 / 75 |
| `agreements.total_amount` | 7.163.078,48 | **7.161.716,00** |
| `installments.original_amount` | 7.161.716,00 | 7.161.716,00 |
| linhas sem `legacy_source` | 3 (`schools`, `customers`, `agreements`) | 0 |

O Supabase carrega 3 linhas sem proveniencia (criadas fora da migracao) e uma divergencia de
**R$ 1.362,48** entre `agreements.total_amount` e `installments.original_amount`; o ensaio local fecha
exatamente. Liberado o disco, a recomendacao e reaplicar a revisao no Supabase (ou reconciliar as 3
linhas e os 24 contatos) antes do cutover - a decisao e do operador.

## Pendencias de entrada ainda abertas

- `asaas_charges`: sem `asaas_customer_id`, `environment`, `billing_type`, `due_date`, `status` e `value` (o status de boleto do legado nao tem mapa decidido);
- `guardians` e `student_contacts`: carregados em 2026-10-27 (`6.347` e `38.962` linhas) e confirmados no dicionario no mesmo dia - a rodada padrao ja os inclui e o portao nao os lista mais;
- `users`: entrada exige politica de credencial (`TBL_USER` nao tem coluna mapeada);
- `students.customer_id`: `TBL_ALUNO` nao tem vinculo com o cliente; os 6.641 alunos ficam sem `customer_id` ate essa decisao;
- as 2 linhas de teste sem `legacy_source` (`schools` = 1, `customers` = 1) ja nao existem no banco local: medicao de 2026-10-27 deu `0` linhas sem proveniencia em `schools`, `customers`, `agreements` e `users` (`schools` 75, `customers` 26.264). Elas seguem no Supabase, onde sao 3 linhas (ver a ultima entrada desta lista).
- canonico do Supabase: segue em somente-leitura por cota de disco e, quando for liberado, precisa receber a revisao (hoje tem 3 linhas sem `legacy_source` e a divergencia de R$ 1.362,48 entre `agreements.total_amount` e `installments.original_amount`, alem de estar 24 contatos atras do ensaio local).

## Entrada de uma aba/arquivo financeiro novo (boletos, payables, cobranca)

A entrada dessa tabela foi conferida **linha a linha** em 2026-09-25, porque o hash do arquivo mudou sem que o do lote mudasse. O arquivo salvo as 14:10 locais (hash `2eb1df54...`) ganhou a aba **`TBL_PAGAMENTO (2)`** (23.961 linhas, 52 colunas) e manteve `TBL_PAGAMENTO_FINANCEIRO` **identica ao que ja estava estagiado** (23.961 linhas no arquivo, 23.961 no lote `5cd769e4-eaaa-49bd-b5ba-7e03947e5e09`, `row_hash` igual em 23.961/23.961: 0 alteradas, 0 novas, 0 removidas). O perfilamento mostra o que essa tabela e:

- e a **mesma tabela** de `TBL_PAGAMENTO_FINANCEIRO`: as 37 colunas e as 23.961 linhas conferem **valor a valor** (36 colunas em comum, **0 com valor diferente**), mais as 15 colunas tecnicas do SharePoint (`Content Type`, `Version`, `Edit`, `Type`, `Item Child Count`, `Folder Child Count`, `Label setting`, `Retention label`, `Retention label Applied`, `Label applied by`, `App Created By`, `App Modified By`, `Compliance Asset Id`, `Color Tag`, `Item is a Record`); a unica diferenca de nome e a primeira coluna, que aqui ficou sem cabecalho (`_col_1` no lugar de `Title`);
- o conteudo e **contas a pagar** do grupo, nao recebiveis: `PAGAMENTO_EMPRESAPAGAR` aponta para 16 empresas do grupo (`ARENA`, `BORRACHAUTO`, `DOM HENRIQUE I`, `DOM HENRIQUE II`, `GENIOS LOJA`, `JFJ ENGENHARIA`, `LIZ EDUCACIONAL`, `LOTUS INCORPORACOES`, `LOTUS PARTICIPACOES`, `NOVO APICE`, `NOVO MARILLAC`...), `PAGAMENTO_DRECATEGORIA` tem 95 categorias de despesa (13o Salario, Aluguel, Agua e Saneamento, Assistencia Medica...), `PAGAMENTO_STATUS` varia entre `APROVADO COMITE`, `DEVOLVIDO`, `EM PAGAMENTO`, `PAGO` e `REPROVADO COMITE`, `PAGAMENTO_TIPO` entre `MANUAL` e `SOLICITACAO`, `PAGAMENTO_FORMA` entre `BOLETO`, `DINHEIRO`, `DOC/TED` e `PIX`, e `PAGAMENTO_APLICACAO` traz 19.214 descricoes de despesa (ex.: `VT 02.2024 ANA DEISE ARAUJO`, `NF 438838 material para...`);
- **nao existe vinculo com acordo nem com parcela** (nenhuma coluna no formato `*.Pagamento.ID`, como as de `TBL_PAGAMENTO_LISTAGEM`), logo ela **nao** alimenta `payments`, `installments` nem `asaas_charges`. Entrou no dicionario como `defer: payables_not_modeled`, igual a `TBL_PAGAMENTO_FINANCEIRO`: o lote fica fora da carga por decisao, nao por falta de dado.

Lote criado com o staging cirurgico da aba nova (mesma fonte legada, para as FKs resolverem entre lotes):

```powershell
python scripts\stage_legacy_workbook.py C:\...\_legacy-powerapps\root-exports\VOA.xlsx --sheets "TBL_PAGAMENTO (2)"
```

- lote `f1691f22-f7ab-4063-a9e8-bae5b0beb69a`, `source_name = VOA.xlsx#sheets=TBL_PAGAMENTO (2)`, 23.961 linhas, com `legacy_source = powerapps-voa`;
- esse lote carrega **os mesmos 23.961 registros** de `TBL_PAGAMENTO_FINANCEIRO`, ou seja, e uma **duplicata**: nao agrega dado novo e pode ser removido do staging quando nao for mais util para comparacao;
- no relatorio da carga (`docs/CANONICAL_LOAD_REPORT.md`, que cobre o lote principal `VOA.xlsx`) as duas abas aparecem reconhecidas, contadas e **deliberadamente fora da carga**: `| TBL_PAGAMENTO (2) | no_mapping | - | 0 | 0 | 0 | 0 |` (a duplicata so tem linhas no lote proprio) e `| TBL_PAGAMENTO_FINANCEIRO | no_mapping | - | 23961 | 0 | 0 | 0 |`;
- o cross-check `--from-staging` olha **apenas o lote principal**: por isso a duplicata aparece em `staging_empty_sheets` (0 linhas estagiadas ali) e nao como erro de coluna;
- a aba em branco `Sheet1` (uma celula sem cabecalho, nenhuma linha) tambem foi declarada no dicionario como `defer: staging_helper`, para que o `SHEET_NOT_IN_DICTIONARY` ficasse em 0.

### Revisao do workbook de 2026-09-25 20:01 (20 abas novas)

O arquivo foi reexportado pelo operador depois da conferencia acima. O que mudou:

- **sairam** `TBL_PAGAMENTO (2)` e `Sheet1`, entao as duas entradas foram **removidas** do
  `scripts/legacy_field_map.json` (o raciocinio de `TBL_PAGAMENTO (2)` continua registrado aqui e o
  `Sheet1` voltou a ser apenas um detalhe da reexportacao anterior). O lote dedicado
  `f1691f22-...` (`source_name = VOA.xlsx#sheets=TBL_PAGAMENTO (2)`) segue no staging, sem uso;
- **entraram 20 abas**: `TBL_EXTRATO`, `TBL_EXTRATO_FINANCEIRO`, `TBL_EXTRATOOLD_FINANCEIRO`,
  `TBL_SUBITEMEXTRATO`, `TBL_CATEGORIAPAGAMENTO`, `TBL_CATEGORIAPAIDRE`, `TBL_CATEGORIAFILHODRE`,
  `TBL_CATEGORIAPRODUTO`, `TBL_CATEGORIAPRODUTO_FINANCEIRO`, `TBL_ITEMDRE`, `TBL_DREAUX`,
  `TBL_DREBASE`, `TBL_DREVALOR`, `TBL_FLUXOCAIXA`, `TBL_FORNECEDOR`, `TBL_FABRICANTE`, `TBL_PEDIDO`,
  `TBL_HISTORICO`, `TBL_HORAATUALIZADO` e `TBL_LOGIN`. Todas entram no dicionario como `defer` com
  motivo explicito, usando dois codigos novos quando necessario: `dre_not_modeled` (plano de contas,
  itens e valores do DRE) e os ja existentes `billing_integration_not_modeled` (extrato, fluxo de
  caixa), `payables_not_modeled` (fornecedor, pedido) e `no_canonical_destination` (produto,
  historico, controle de atualizacao). `TBL_LOGIN` segue a mesma politica de `TBL_USER`:
  `LOGIN_PASS` e `ignore: secret_revoked` e o resto so entraria com email novo e senha redefinida;
- **`TBL_EXTRATO` e `TBL_CATEGORIAPRODUTO` vieram vazias** (nenhum cabecalho). O conteudo esta nas
  abas irmas `TBL_EXTRATO_FINANCEIRO` (39.944 linhas, cobre 29/29 campos que a app le) e
  `TBL_CATEGORIAPRODUTO_FINANCEIRO` (2 linhas, cobre 1/1). `TBL_EXTRATOOLD` nao ganhou aba propria:
  os 16 campos que a app le estao em `TBL_EXTRATOOLD_FINANCEIRO` (64.451 linhas). O auditor resolve
  esse caso sozinho (secao 3b de `docs/LEGACY_APP_SOURCE_GAPS.md`); o dicionario aponta cada tabela
  para a aba declarada;
- as 20 abas novas **ainda nao foram estagiadas**: o lote mais recente de `VOA.xlsx`
  (`5cd769e4-eaaa-49bd-b5ba-7e03947e5e09`, 419.700 linhas, 38 abas com conteudo) e anterior a esta
  revisao. O `--preview` do stager conta **60 abas e 546.346 linhas de dados** e o
  `db:field-dictionary-check` mostra 19 `empty_sheet` (informativo) ate o staging rodar:

```powershell
python scripts\stage_legacy_workbook.py
```

- o cross-check `--from-staging` so acusou `empty_sheet` (0 `column_mismatch`): as abas que ja estavam
  no lote continuam com as mesmas colunas, ou seja, a reexportacao nao mexeu nelas.

Para a proxima aba ou arquivo, o caminho continua o mesmo, sem mudanca de codigo:

```powershell
# 1. staging do novo arquivo (o legacy_source da carga continua sendo powerapps-voa)
python scripts\stage_legacy_workbook.py C:\caminho\VOA-FINANCEIRO.xlsx --json-out "$env:TEMP\voa_stage_fin.json"

# 2. dicionario: declarar a aba nova em scripts\legacy_field_map.json e conferir cobertura
npm run db:field-dictionary-check

# 3. carga do lote novo (as tabelas ja confirmadas carregam sem flag)
npm run db:load-canonical -- --batch-id <id-do-lote-novo>
npm run db:load-canonical-commit -- --batch-id <id-do-lote-novo>
```

Pontos que ja estao resolvidos e nao precisam de decisao:

- o novo arquivo gera um **lote proprio** (`migration_batches` tem `UNIQUE (source_name, source_hash)`), e a resolucao de referencias nao filtra por lote: ela busca em `legacy_source` (`WHERE legacy_source = %s AND legacy_table = %s AND legacy_id = %s`). Ou seja, basta subir o novo arquivo com `--legacy-source powerapps-voa` (o padrao) para que `customer_id`, `student_id`, `school_id` e `agreement_id` achem as linhas ja carregadas do `VOA.xlsx`;
- `migration_rows` e unico por `(batch_id, source_sheet, source_row_number)`, entao a aba nova nao colide com o lote antigo mesmo que repita o nome de uma aba;
- a fidelidade arquivo -> staging foi revalidada **por hash de linha** em 2026-09-25: `TBL_ALUNO` (6.652), `TBL_CLIENTE` (24.696), `TBL_PAGAMENTO` (1.572), `TBL_PAGAMENTO_LISTAGEM` (15.535) e `TBL_PAGAMENTO_FINANCEIRO` (23.961) batem 100% com o lote `VOA.xlsx` (0 alteradas, 0 novas, 0 removidas): nao ha nada a re-estagiar antes da carga financeira;
- `build_field_dictionary.py` le o arquivo em disco: a diferenca entre workbook e staging sai como `empty_sheet` (informativo, nao derruba o gate) e so `column_mismatch` retorna codigo `3`.

O lado de **recebiveis** (os boletos de verdade) nao depende de arquivo novo: ele ja esta no `VOA.xlsx` original, em `TBL_PAGAMENTO` (1.572 acordos), `TBL_PAGAMENTO_LISTAGEM` (15.535 parcelas/cobrancas) e `TBL_DIVIDA`/`TBL_DIVIDA_LISTAGEM` (6.868 dividas, 42.886 parcelas). O que falta ali e decisao de mapeamento e cobertura de coluna obrigatoria:

| Tabela | Colunas que faltam | Observacao |
|---|---|---|
| `agreements` | `customer_id`, `total_amount`, `installments_count` | `customer_id` nao existe em `TBL_PAGAMENTO`/`TBL_DIVIDA`; se o vinculo for sempre `aluno -> cliente`, precisa vir uma coluna de cliente (o carregador nao infere join entre tabelas) |
| `installments` | `agreement_id`, `installment_number`, `due_date`, `original_amount` | `TBL_PAGAMENTO_LISTAGEM` ja cobre as quatro colunas, mas o mapeamento esta `proposed`; as 245 duplicidades de (acordo, parcela) passam a ser descartadas como `LOAD_DUPLICATE_ROW`, sem abortar a carga |
| `payments` | `installment_id`, `amount` | mapeado a partir de `Pagamento_Listagem.Valor_Pago`/`Data_Pagamento` (status `proposed`); `amount` tem `CHECK (amount > 0)`, entao valor zerado vira `LOAD_ROW_REJECTED` |
| `asaas_charges` | `asaas_customer_id`, `environment`, `billing_type`, `value`, `due_date`, `status` | `environment` so aceita `sandbox` ou `production`; `external_id` e `UNIQUE` |
| `asaas_customers` | `customer_id`, `external_id`, `environment` | **elo que falta na cadeia**: `asaas_charges.asaas_customer_id` referencia `asaas_customers`, que ainda nao e carregavel por nenhuma aba. Sem decidir a origem desse mapa (o candidato legado e `Pagamento_CliAsaas_ID`, 1.122 preenchidos, ambiente desconhecido), `asaas_charges` continua bloqueada |

Numeros medidos no arquivo atual (iguais aos do lote principal), para dimensionar a decisao: `TBL_PAGAMENTO` tem 1.572 linhas com `Pagamento.Escola_ID` (1.571 preenchidos), `Pagamento.Aluno_ID` (1.568) e `Pagamento_CliAsaas_ID` (1.122, formato `cus_000167671969`); `TBL_PAGAMENTO_LISTAGEM` tem 15.535 linhas com `Pagamento_Listagem.Pagamento.ID` (15.529), `Pagamento_Listagem.Parcela_Numero` e `Data_Vencimento` (15.534), `Valor_Parcela` (15.533), `Valor_Pago` (13.245), `Data_Pagamento` (11.983), `Pagamento_PagAsaas_ID` (6.369, formato `pay_...`), `Pagamento_LinkPag` (6.356) e `Pagamento_CopiaeCola` (6.369). O formato do id (`cus_`/`pay_`) nao distingue sandbox de producao, entao `environment` continua sendo decisao humana.

Duas limitacoes conhecidas do dicionario, para nao gerar retrabalho:

1. `links` so resolve vinculo **dentro da mesma linha** (`row:<tabela>`). Se a origem de cobranca trouxer a parcela em linha separada do pagamento, o carregador vai precisar de um modo de vinculo por chave (ex.: acordo legado + numero da parcela); isso e uma mudanca pequena e localizada em `build_plan`/`store_row`.
2. `TBL_PROCESSODIVIDA` e `TBL_EMAILCOBRANCA` ja existem no dicionario como abas conhecidas, porem sem nenhuma coluna mapeada: se um arquivo novo corresponder a uma delas, o trabalho e preencher decisoes, nao criar estrutura.

## Investigacao de encoding e acentos

O lote completo foi auditado com dois metodos independentes:

1. Varredura dos 3.676.857 valores de texto do staging (por campo e por caractere).
2. Comparacao direta entre a celula do `VOA.xlsx` (openpyxl) e o payload do staging.

Resultado: o texto esta em UTF-8 correto. `Escola.Nome`, `Escola.Endereco`, `Aluno.Nome`,
`CLIENTE_NOME`, `EMPRESA_NOME` e as observacoes de `TBL_CONTATO` conferem byte a byte com
a planilha (`Colégio Mazza Branco`, `nº 275`, `Carapicuíba`, `Joaquim Moura Romão`,
`LOTUS INCORPORAÇÕES`, `ESCRITÓRIO`, `MARIANA VITÓRIA`, `NÃO ENVIADO`, `nº`, `m²`, `§ 2º`).
Nao existe nenhuma assinatura de mojibake no dado, nem no staging nem nos arquivos do repositorio.

### Por que os acentos aparecem errados no terminal

O `python.exe` deste ambiente escreve stdout em **cp1252** (`sys.stdout.encoding == 'cp1252'`)
enquanto o PowerShell 5.1 decodifica um fluxo redirecionado em **cp850**. A composicao dos
dois transforma texto correto em lixo visual:

```text
texto correto            : 'Não Colégio São Paulo'
bytes cp1252             : 4e e3 6f 20 43 6f 6c e9 67 69 6f ...
lido como cp850 (console): 'NÒo ColÚgio SÒo Paulo'   <-- artefato de exibicao
```

Ou seja: `NÒo`, `ColÚgio`, `EducaþÒo`, `SÒo Paulo` vistos em logs de terminal **nao** sao
corrupcao de dado. Por isso a regra de ouro deste projeto: evidencia de encoding sempre em
arquivo UTF-8, nunca pela tela.

### Como rodar vendo os acentos corretos

- Prefira `--json-out` e `--report` (gravam UTF-8 direto no arquivo) em vez de `>`.
- Se precisar do console, ajuste a sessao antes de rodar:

```powershell
chcp 65001
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
```

### Deteccao automatica no validador

O validador reporta `TEXT_ENCODING_SUSPECT` (warning) apenas para assinaturas inequivocas:

- bytes Windows-1252 lidos como CP850 (`Não` -> `NÒo`): `Ò ß þ Û Ý È Ë ¬ ¾ ║ ┌ └ ├ ┬ ┴ ═ ╔ ╩ ▄ ░ ı`;
- bytes UTF-8 lidos como Windows-1252/Latin-1 (`Não` -> `NÃ£o`, `“x”` -> `â€œxâ€`).

Renderizacoes ambiguas (`Ú` no lugar de `é`) e caracteres legitimos de tipografia
(`– — ‘ ’ “ ” … ´ ² ³ · ¶ º ª ñ`) **nao** geram aviso, porque `ÚNICO`, `MARIANA VITÓRIA`,
`m²`, `§ 2º` e `D´Arc` sao texto correto. A decisao desses casos pertence a fase de
dicionario, coluna a coluna.

## Lacunas entre a app legada e as planilhas (2026-09-25)

O Canvas App legado le Dataverse (57 tabelas `TBL_*`) e nao o workbook. Para saber o que a app
consulta e a planilha nao entrega, rodar:

```powershell
npm run db:audit-app-sources
```

O script `scripts/audit_legacy_app_sources.py` localiza a copia descompactada mais recente da app,
le os `DataSources/*.json`, os cabecalhos do workbook em disco e a solucao Dataverse exportada
(`_legacy-powerapps/.../Dataverse/SolutionExport/CDSDefault_unmanaged_unpacked/Entities`), conta as
referencias de campo no `Src/**/*.fx.yaml` e regrava `docs/LEGACY_APP_SOURCE_GAPS.md`. Ele nao
conecta no banco.

Resultado da ultima execucao (revisao do workbook de 2026-09-25 20:01, 60 abas):

| Achado | Numero |
|---|---:|
| Data sources da app (57 tabelas + 5 fontes externas) | 274 |
| Abas do workbook / entidades Dataverse | 60 / 60 |
| Tabelas lidas pela app **sem aba** no workbook | 2 |
| Tabelas cujo conteudo esta em **aba irma** (`_FINANCEIRO`) | 3 |
| Campos de negocio lidos pela app que faltam na aba correspondente | 2 |
| Colunas das abas que nao existem no schema atual do Dataverse | 4 |
| Abas do workbook sem entidade correspondente | 3 |

As 20 tabelas que apareciam sem aba foram para o workbook nesta revisao, menos as duas que ficaram de
fora de proposito. O auditor passou a resolver **aba irma**: quando a aba com o nome exato da tabela
esta vazia (ou nao existe) e uma aba com sufixo tem os campos que a app le, o diagnostico usa a aba
sufixada e registra o caso na secao 3b do relatorio.

| Tabela | Aba com o nome da tabela | Aba usada | Campos cobertos |
|---|---|---|---|
| `TBL_CATEGORIAPRODUTO` | `TBL_CATEGORIAPRODUTO` (vazia) | `TBL_CATEGORIAPRODUTO_FINANCEIRO` | 1/1 |
| `TBL_EXTRATO` | `TBL_EXTRATO` (vazia) | `TBL_EXTRATO_FINANCEIRO` | 29/29 |
| `TBL_EXTRATOOLD` | nao existe | `TBL_EXTRATOOLD_FINANCEIRO` | 16/16 |

Pontos que precisam de decisao:

- `TBL_CONTA`: a app le `CONTA_NOME` (27 referencias, `Screen_CadExtrato`) e a aba so tem
  `CONTA_DESCRICAO`, coluna que nao existe no Dataverse de hoje;
- `TBL_CENTRODECUSTO`: a app le `EMPRESA_ID` e a aba so tem `CENTRODECUSTO_EMPRESA_ID`
  (mesmo caso: nome antigo dentro da aba);
- `TBL_CONSULTA` (1 campo, `CONSULTA_CONTATO_ALUNO_ID`) e `TBL_EMAILISTACONTATO` (4 campos de
  contato de cobranca) ficaram **fora** da revisao por decisao do operador: a primeira e um lookup
  para `TBL_CONSULTA_CONTATO` (aba ja existente desde antes) e a segunda continua nao migrada. O
  auditor segue listando as duas na secao 1 enquanto isso nao mudar;
- `TBL_EMAILISTACONTATO` (entidade) x `TBL_EMAILLISTACONTATO` (aba, 0 linhas): a aba tem um `L` a
  mais e nunca foi preenchida, embora a app leia `Aluno_Nome`, `Escola_Nome`, `Data_Ultimo_Contato` e
  `Dias_Ate_Hoje` dessa tabela;
- as 20 abas novas da revisao ja estao declaradas no dicionario com motivo explicito
  (`payables_not_modeled`, `billing_integration_not_modeled`, `dre_not_modeled`,
  `no_canonical_destination`, `user_import_requires_credential_reset`), o que zerou
  `SHEET_NOT_IN_DICTIONARY`;
- 5 fontes externas nunca estiveram no workbook: `CriarClienteVOAnoAsaas`, `VoaCriarBoletosManual`,
  `VOAExcluirCliente` e `EnvioEmailVisita` (conectores) e `ImportarExtrato` (tabela de Excel Online
  com `Valor`, `Categoria`, `Centro de Custo`, `Cliente/Fornecedor`, `Conta`, `Data Lancamento`,
  `Data pagamento`, `Descricao`, `Empresa`).

Detalhe completo (tabela a tabela e campo a campo) em `docs/LEGACY_APP_SOURCE_GAPS.md`.

