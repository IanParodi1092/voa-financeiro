# Fluxo de migracao do legado

## Estado atual

- O workbook legado foi perfilado em modo somente leitura.
- O importador dry-run grava somente `migration_batches`, `migration_rows`, `migration_errors` e `reconciliation_reports`.
- Nenhuma escola, cliente, aluno, acordo, parcela, pagamento ou cobranca canonica e criada nesse modo.
- Senhas, API keys e tokens sao substituidos por `[REDACTED]` antes de persistir o payload.
- O lote completo `VOA.xlsx` (419.700 linhas em 39 abas) esta em staging e ja passou por validacao. A revisao de 2026-09-25 20:01 do arquivo tem **60 abas e 546.346 linhas de dados** (contagem do `--preview` do stager) e **ainda nao foi estagiada**: ate esse staging rodar, o `db:field-dictionary-check` mostra 19 `empty_sheet` (informativo, nao derruba o gate).
- A validacao registra achados por aba/campo, marca linhas com erro e atualiza `reconciliation_reports`.
- O relatorio consolidado da ultima validacao esta em `docs/STAGING_VALIDATION_REPORT.md`.
- O dicionario da fase 2 esta em `scripts/legacy_field_map.json` (60 abas, 856 colunas, 0 sem decisao): 30 `map`, 76 `ignore`, 713 `defer` e 37 `review`.
- A comparacao entre o Canvas App legado e as planilhas esta em `docs/LEGACY_APP_SOURCE_GAPS.md`, gerada por `scripts/audit_legacy_app_sources.py` (`npm run db:audit-app-sources`): 2 tabelas lidas pela app nao tem aba (`TBL_CONSULTA` e `TBL_EMAILISTACONTATO`, deixadas fora de proposito), 2 campos de negocio faltam nas abas que existem (`CONTA_NOME`, `EMPRESA_ID`), 3 tabelas tem o conteudo em aba irma (`_FINANCEIRO`) e 5 fontes fora do Dataverse (conectores e Excel Online) nunca estiveram no workbook.
- O relatorio do dicionario esta em `docs/FIELD_MAPPING_DICTIONARY.md`, gerado por `scripts/build_field_dictionary.py`.
- A carga canonica (fase 7) esta em `scripts/load_canonical_batch.py`, com dry-run por padrao. Em 2026-09-25 ela carregou 78.217 linhas de `schools`, `customers`, `contacts` e `students` e, na mesma data, a cadeia financeira (`agreements`, `installments`, `payments`, `asaas_customers` e o cliente pagador sintetizado) com `agreements.total_amount` fechando exatamente com a soma de `installments.original_amount`; o relatorio da ultima rodada esta em `docs/CANONICAL_LOAD_REPORT.md`.
- O profiler esta em `scripts/profile_legacy_workbook.py`.
- O importador de staging esta em `scripts/stage_legacy_workbook.py`.
- O validador de staging esta em `scripts/validate_staging_batch.py`.
- Dependencias Python dos scripts: `scripts/requirements.txt` (openpyxl e psycopg 3).
- Fontes antigas permanecem em `_legacy-powerapps/`.

## Fases obrigatorias

1. **Perfil** (concluido): contar registros, colunas, vazios, duplicidades e campos sensiveis.
2. **Dicionario** (concluido com pendencias): cada coluna legada recebe decisao explicita (`map`, `ignore`, `defer` ou `review`) em `scripts/legacy_field_map.json`, com tipo, normalizacao e motivo. As colunas `review` e os mapeamentos `proposed` bloqueiam a aprovacao do lote.
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
- `status: "proposed"` marca mapeamento ainda nao confirmado (tambem bloqueia).
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
npm run db:load-canonical-commit -- --allow-proposed contacts
```

`scripts/load_canonical_batch.py` le o lote de staging, resolve o dicionario e grava as tabelas canonicas. Regras:

1. nada e inferido: uma tabela so carrega quando toda coluna canonica `not null` sem `default` esta coberta por um `map` (ou por um `links`) e quando as tabelas das quais ela depende ja foram carregadas;
2. `--commit` e obrigatorio para escrever; sem ele o comando e um dry-run que calcula exatamente o mesmo plano, as mesmas contagens e os mesmos achados;
3. nenhuma linha e fundida, renomeada ou apagada: a linha que o mapeamento nao satisfaz e descartada, contabilizada e reportada, e o payload de staging permanece intacto;
4. idempotencia: tabelas com `legacy_source`/`legacy_table`/`legacy_id` reutilizam o UUID existente; tabelas sem essas colunas (`contacts`, `installments`) recebem um UUID deterministico derivado da linha de origem, entao rodar de novo nao duplica nada;
5. mapeamento `status: "proposed"` so carrega com `--allow-proposed <tabela>` explicito do operador, e a aprovacao fica registrada em `reconciliation_reports.notes`;
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

## Pre-condicoes da carga canonica

Antes de aprovar o lote e rodar a carga com UUIDs novos:

1. `python scripts/build_field_dictionary.py --from-staging` sai com codigo `0` (nenhuma coluna sem decisao, nenhum destino inexistente e nenhuma divergencia de coluna entre workbook e staging).
2. `python scripts/build_field_dictionary.py --gate approved` sai com codigo `0`: nao existe coluna `review` nem mapeamento `status: "proposed"`. Hoje ele sai com codigo `2` e 55 pendencias.
3. `migration_batches.status` do lote e alterado para aprovado somente depois do item 2.
4. O banco canonico nao contem linhas de teste. Em 2026-09-24 existiam `schools` = 1 (legal_name `Escola Teste`) e `customers` = 1 (full_name `Ian`), ambas sem `legacy_source`/`legacy_table`/`legacy_id` e anteriores ao lote de staging; elas continuam no banco (identificaveis por `legacy_source IS NULL`) e devem ser removidas ou isoladas para nao poluir a reconciliacao:
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

## Pendencias de entrada ainda abertas

- `asaas_charges`: sem `asaas_customer_id`, `environment`, `billing_type`, `due_date`, `status` e `value` (o status de boleto do legado nao tem mapa decidido);
- `users`: entrada exige politica de credencial (`TBL_USER` nao tem coluna mapeada);
- `students.customer_id`: `TBL_ALUNO` nao tem vinculo com o cliente; os 6.641 alunos ficam sem `customer_id` ate essa decisao;
- as 2 linhas de teste sem `legacy_source` (`schools` = 1, `customers` = 1) continuam no banco e poluem a reconciliacao (`schools` 76 no canonico para 75 linhas legadas).

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

# 3. carga do lote novo
npm run db:load-canonical -- --batch-id <id-do-lote-novo> --allow-proposed installments,payments,asaas_charges
npm run db:load-canonical-commit -- --batch-id <id-do-lote-novo> --allow-proposed installments,payments,asaas_charges
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

