# Triagem das pendencias `review` do dicionario (fase 2)

- Data da triagem: `2026-10-22` (revisao `2026-10-27`: decisao da classe C, migrations `0010`/`0011`, aprovacao das 11 propostas e fechamento das 3 decisoes de produto que faltavam)
- Status: **fechada**. Nenhuma coluna esta em `review` e nenhum `map` depende de aprovacao avulsa, entao o portao `approved` sai `0`. Em 2026-10-27 o operador confirmou os 11 `proposed` (classe A', classe C e contato do aluno) e as tres decisoes de produto que sobravam: `Pagamento_DataFechamento` e `TBL_USER.ID` sairam de `review` e as quatro colunas de cobranca Asaas sairam de `map` (ver "Decisoes de 2026-10-27"). A classe C foi decidida em 2026-10-27 (fica em `review`) e **reabriu na `0011`**: com a entidade `guardians`, as duas colunas do responsavel entraram como `proposed` e foram confirmadas pelo operador no mesmo dia. A classe D teve o schema fechado pela `0010` e a carga do contato do aluno (`TBL_ENDTEL`) mapeada na `0011`, tambem `proposed` e confirmada
- Dicionario: `scripts/legacy_field_map.json` (60 abas, 856 colunas: 46 `map`, 79 `ignore`, 731 `defer`, 0 `review`)
- Lote de staging consultado: `4609c071-03c3-47fb-beff-5c3bcad6367e` (`committed`, 546.346 linhas) no Postgres local
- Relatorios de referencia: `docs/FIELD_MAPPING_DICTIONARY.md` (gerado), `docs/CANONICAL_LOAD_REPORT.md`, `docs/STAGING_VALIDATION_REPORT.md`
- Schema comparado: `apps/api/migrations/0001..0011`. A `0009` proveu `installments.legacy_*` e `contacts.legacy_*`; a `0010`, `agreements.closed_at`, `student_contacts` e `users.legacy_*`; a `0011`, `guardians` e `student_contacts.status`. Segue sem tabela/coluna apenas o endereco/contato de escola (`school_addresses`)

Este documento responde duas perguntas por coluna: **o que a coluna e** (com dado do proprio lote, nao com o nome) e **qual decisao fecha a pendencia**, junto do efeito no portao de aprovacao. Nada aqui grava no banco: as consultas foram `select` no staging e as propostas sao edicoes no JSON do dicionario.

## Leitura rapida

- **Nenhuma coluna em `review`** das 31 triadas: as classes A, B, E e A' fecharam 23, a `0011` fechou as 3 ultimas que ainda tinham `review` (nome e CPF do responsavel, `ENDTEL_ALUNO_ID`), em 2026-10-27 o operador **confirmou os 11 `proposed`** que restavam (`Pagamento_Nome`, as 5 do guardiao e as 5 do contato do aluno) e as 2 ultimas decisoes de produto foram tomadas no mesmo dia.
- O portao esta em **`0` itens**: `python scripts\build_field_dictionary.py --from-staging --gate approved` sai `0`, sem `REVIEW_REQUIRED` e sem `MAPPING_NOT_CONFIRMED`. `--allow-proposed` continua aceito como rede de seguranca, mas nao ha mais nada para liberar.
- A classe A' foi confirmada em 2026-10-27 depois da validacao em tela de `agreements.reference`: a cadeia financeira (`agreements` -> `installments` -> `payments`) voltou a carregar na rodada padrao, sem flag nenhuma.
- `guardians` e `student_contacts` seguem o mesmo caminho: a rodada padrao avalia `176.205` linhas e carrega `150.018` (`104.709` de antes + `6.347` guardioes + `38.962` contatos de aluno). Desde 2026-10-27 ela sai `0`: o `exit 4` era apenas o `asaas_charges`, que saiu do plano de carga. Antes da `0011` a mesma rodada fazia `89.349`/`80.929`, porque `agreements` bloqueado derrubava `installments` e `payments`.
- A escrita real na base local (`python scripts\load_canonical_batch.py --commit --enrich-reused`) fez `inserted=0`, `reused=150.018` e `enriched=1.504`: materializou o `agreements.reference` das linhas que ja existiam (1 das 1.505 continua nula porque `Pagamento_Nome` vem vazio na origem).
- `TBL_DIVIDA` (6.868 linhas) e `TBL_DIVIDA_LISTAGEM` (42.886 linhas) continuam fora do canonico (`no_mapping` no relatorio da carga) e agora estao registradas assim no dicionario (`defer: no_canonical_destination`). Isso nao e pendencia de dicionario: e escopo - inadimplencia nao esta modelada.

## Decisoes de 2026-10-27 (fecham o portao)

As tres colunas que ainda pediam decisao de produto foram decididas com dado do proprio lote. Nenhuma delas virou `map`: as tres sao `defer`, porque nao existe destino canonico honesto para o valor.

| Coluna | Decisao | Evidencia |
|---|---|---|
| `TBL_PAGAMENTO.Pagamento_DataFechamento` | `defer: no_canonical_destination` | 1.497 de 1.572 preenchidos (2021-2026, datetime ISO). Cruzando com as parcelas de staging: **830 anteriores ao primeiro vencimento**, 418 entre parcelas, 191 posteriores a ultima (58 acordos sem parcela carregavel). O rotulo da origem e a data de formalizacao do acordo, nao o encerramento do parcelamento |
| `TBL_USER.ID` | `defer: user_import_requires_credential_reset` | 28 usuarios internos; `USER_SENHA`/`USER_PASS` sao credenciais que nao migram e `users.password_hash` e `NOT NULL`. A identidade nasce em `auth:create-admin` |
| `TBL_PAGAMENTO_LISTAGEM.Pagamento_PagAsaas_ID` (e `LinkPag`, `CopiaeCola`, `Banco_Status`) | `defer: billing_integration_not_modeled` | 6.369 `external_id` distintos em 15.535 parcelas, mas `asaas_charges` exige `asaas_customer_id` (NOT NULL) + `billing_type`, `environment`, `value` e `due_date`; a aba nao carrega o cliente Asaas (`Pagamento_CliAsaas_ID` e vazio nela, o vinculo so existe em `TBL_PAGAMENTO`, 1.122 preenchidos) |

Por que `Pagamento_DataFechamento` nao virou `agreements.closed_at`: gravar a data de formalizacao em uma coluna de encerramento marcaria **1.391 acordos que ainda tem parcela aberta** como fechados, e a tela de acordos ativos passaria a mentir. `agreements.closed_at` (migration `0010`) passa a ser escrita **pela aplicacao**, via `PATCH /api/v1/agreements/:id` (`closedAt`, `null` reabre), com trilha em `audit_logs`.

Por que o historico de cobranca nao entra: o valor financeiro do legado ja esta em `installments`/`payments` (valor, data, status e retencao), e o link/boleto/Pix antigo expira junto com a cobranca. Preencher `environment`/`billing_type` com constante derivaria dado inexistente. A fonte da verdade de `asaas_charges` passa a ser a integracao Asaas do backend, que reconcilia por `external_id` (coluna `UNIQUE`).

Reabrir qualquer uma das tres exige apenas editar `scripts/legacy_field_map.json` e rodar o portao; o plano de carga ja sabe lidar com `asaas_charges` bloqueada (`required_columns_uncovered`) se o mapa voltar sem as cinco colunas obrigatorias.

## Resumo por classe

| Classe | Itens | O que e | Decisao | Status |
|---|---:|---|---|---|
| A | 6 | semantica agora comprovada, sem destino canonico | `ignore`/`defer` com motivo do vocabulario | aplicada |
| A' | 1 | semantica comprovada **e** destino canonico livre | `map: agreements.reference` com `status: "confirmed"` (aprovado em 2026-10-27) | aplicada e confirmada |
| B | 10 | herdam a decisao de 2026-09-25 (`agreements` vem de `TBL_PAGAMENTO`) | `defer: no_canonical_destination` | aplicada |
| C | 2 | politica de identidade (nome e CPF do responsavel) | `map` para `guardians` com `status: "confirmed"` (reaberta pela `0011`, aprovada em 2026-10-27) | aplicada e confirmada |
| D | 6 | exigem migration ou dependem da classe B | migration (schema) + carga | 2 aplicadas na `0009`, 1 fechada por B, 3 no schema pela `0010`; `TBL_ENDTEL` e os dados do guardiao carregados e confirmados na `0011` |
| E | 6 | endereco de escola: semantica clara, tabela inexistente | `defer: address_not_modeled` | aplicada |

### O que esta aplicado (2026-10-22)

- 22 colunas reescritas em `scripts/legacy_field_map.json` (A + B + E), com nota de evidencia em cada uma e sem mudar nenhum `map` existente.
- Classe A' aplicada em 2026-10-22 e **confirmada em 2026-10-27**: `TBL_PAGAMENTO.Pagamento_Nome` virou `map: agreements.reference` com `type: text`, `normalization: collapse_ws` e `status: "confirmed"` (23a coluna fora de `review`; nenhuma outra coluna escreve em `agreements.reference`).
- `TBL_DIVIDA_LISTAGEM.ID` saiu de `review` junto com a classe B: com a aba fora do canonico o id do item nao tem destino, entao o gap `installments_legacy_id` nao se aplica a ele.
- Gap `agreements_source_resolution` mantido como referencia, com descricao reescrita ("resolvido em 2026-09-25"); gaps `installments_legacy_id` e `contacts_legacy_id` marcados como resolvidos pela `0009` + backfill.
- Migration `apps/api/migrations/0009_contacts_installments_legacy_provenance.sql`: colunas `legacy_source/legacy_table/legacy_id` + indice unico em `contacts` e `installments`.
- `scripts/backfill_legacy_provenance.py` (+ `npm run db:backfill-legacy-provenance`): carimbou 46.829 `contacts` e 15.259 `installments` (0 divergencias, 0 a carimbar na segunda rodada) e as duas colunas `ID` viraram `map` com `provides_legacy_id_for`.

### O que esta aplicado (2026-10-27)

- `apps/api/migrations/0010_class_d_schema_gaps.sql`: as tres lacunas de schema que sobravam da classe D - `agreements.closed_at`, a tabela `student_contacts` (espelho de `contacts`, com `student_id` e proveniencia legada) e `users.legacy_source/legacy_table/legacy_id` + indice unico.
- A `0010` e **inerte para a carga**, como a `0009`: nenhuma coluna do dicionario passou a apontar para o schema novo, entao a rodada `--allow-proposed agreements` continuou em `inserted=0`, `reused=104.709` e o portao com os mesmos 6 itens (numeros de antes da `0011`; hoje a rodada padrao faz `176.205`/`150.018`). O que muda e o motivo do bloqueio: as tres colunas sairam de `schema_gap_pending`/`student_contact_not_modeled` para `pending_policy`, `user_import_requires_credential_reset` e `student_contact_load_pending`.
- Gap `students_contact` reescrito como resolvido no schema (a carga da aba `TBL_ENDTEL` e outra etapa); gaps `agreements_closed_at` e `users_legacy_import` idem.
- Decisao de identidade da classe C registrada: as duas colunas ficam em `review` (secao da classe C). Essa decisao foi revista pela `0011` - ver a secao seguinte.

### O que esta aplicado (2026-10-27, migration `0011`)

- `apps/api/migrations/0011_guardians_and_student_contact_status.sql`: cria `guardians` (filha de `students`, com `customer_id` nullable, nome/CPF/RG/estado civil/profissao e proveniencia legada) e adiciona `student_contacts.status`.
- A `0011` **reabre a classe C**: `Aluno.Responsavel_Financeiro` e `Aluno.CPFResponsavel` sairam de `review` e viraram `map` para `guardians`, abertas como `status: "proposed"` e **confirmadas pelo operador em 2026-10-27**. O responsavel deixa de ser candidato a `customers` (era a razao do bloqueio) e passa a ter entidade propria; `customer_id` nasce nulo e `is_verified` falso.
- `TBL_ENDTEL` deixou de ser aba `deferred` e virou entidade de `student_contacts` (`type`, `value`, `is_primary`, `status`), tambem `proposed` e confirmado no mesmo dia. A aba tem 47.562 linhas: 41.117 com tipo e valor, 457 com tipo e valor vazio, 5.988 vazias nas duas colunas e no status - por isso **nao** existe rotulo sintetico `unknown`: nao ha dado a gravar nessas 5.988.
- **A carga padrao virou a rodada completa**: com os 11 `proposed` confirmados, a rodada sem flag nenhuma faz `considered=176.205`, `loaded=150.018`, `inserted=0`, `reused=150.018` e, desde 2026-10-27, `exit 0` (o `asaas_charges` saiu do plano de carga; era ele o `exit 4`). Antes da aprovacao a mesma rodada fazia `121.991`/`104.709` com `--allow-proposed agreements` e `89.349`/`80.929` sem flag nenhuma.
- Composicao dos `150.018`: os `104.709` de antes mais `6.347` guardioes (294 sem nome, 11 sem aluno) e `38.962` contatos de aluno (2.797 com aluno fora da carga, 5.389 sem tipo, 413 sem valor). Segunda rodada `inserted=0`/`reused=150.018`: a chave legada segura a idempotencia.
- Gap `students_contact` e gap `students_guardian_details` reescritos como resolvidos (`0010`/`0011`). Vocabulario perdeu os tres motivos que ficaram sem uso (`student_contact_load_pending`, `unreliable_document_source`, `name_only_link_not_allowed`).



## Classe A - semantica comprovada, sem destino canonico (6)

| Aba | Coluna | Evidencia no lote | Proposta |
|---|---|---|---|
| `TBL_ALUNO` | `Aluno_AnoDivida` | 5.066 vazios em 6.652; valores `2014`..`2022` com cauda em `1900` (19 linhas) e `1969` (2) | ano de referencia da divida (inferencia a confirmar). `agreements` e `students` nao tem coluna de ano: `defer: no_canonical_destination` |
| `TBL_ALUNO` | `Aluno_Contrato` | booleano: `false`=3.754, `true`=1, vazio=2.897 | flag "contrato assinado" sem uso pratico (1 `true` em 3.755) e sem coluna em `students`: `ignore: legacy_flag` |
| `TBL_CLIENTE` | `CLIENTE_INEP` | 24.696 linhas; 12.259 vazios; 12.171 distintos, todos com 8 digitos (ex. `25020846`) e quase todos repetidos 2x | codigo INEP de escola replicado por linha de cliente; `schools` nao tem coluna INEP: `defer: school_config_not_modeled` |
| `TBL_AUXSUBIR` | `Nome Escola2` | 9.553 linhas, 9.099 chaves distintas, com ordem de palavras normalizada (`DOM BOSCO COLEGIO` para "Colegio Dom Bosco") | chave derivada para conciliar com `TBL_ESCOLA`, nao e dado novo: `ignore: computed_cache` |
| `TBL_DIVIDA_LISTAGEM` | `Divida_Listagem.Tipo_de_debito` | 1.074 distintos, com lixo (`0`, `[PIUYTREW`) | `installments` nao tem tipo/descricao (o gap `installments_description` continua registrado): `defer: no_canonical_destination` |
| `TBL_PAGAMENTO_LISTAGEM` | `Pagamento_Listagem_Tipo` | 15.063 preenchidos: `Pagamento Padrao`=14.923, `Pagamento Resgate Judicial`=140, vazio=472 | `payments` nao tem tipo, e `payments.source` guarda a origem tecnica (`manual`/Asaas), nao o tipo: `defer: no_canonical_destination` |

Nenhuma dessas seis colunas perde dado: o payload de staging guarda o valor original e o motivo fica escrito no dicionario.

## Classe A' - semantica comprovada com destino canonico (1)

| Aba | Coluna | Evidencia no lote | Decisao (aplicada em 2026-10-22) |
|---|---|---|---|
| `TBL_PAGAMENTO` | `Pagamento_Nome` | 1.570 de 1.572 preenchidos; 73 rotulos: `Acordo 2023`=557, `Acordo 2024`=438, `Acordo 2025`=186, `Acordo_2022`=99, `Acordo 1`=97, `acordo 2022`=84, `Acordo2024`=21, `Acordo pago na escola`=4 | rotulo do lote de acordo; `agreements.reference` existe no schema e nenhuma outra coluna escreve nela: `map: agreements.reference`, `type: text`, `normalization: collapse_ws`, `status: confirmed` (aprovado em 2026-10-27) |

Tres cuidados:

1. 73 rotulos para 1.505 acordos: `reference` agrupa lotes (`Acordo 2024`), nao identifica acordo - a identidade continua em `agreements.legacy_id`, que vem de `TBL_PAGAMENTO.ID`.
2. A grafia varia (`Acordo_2022`, `acordo 2022`, `Acordo2024`). Unificar em `Acordo 2022`/`Acordo 2024` e decisao de produto; `collapse_ws` apenas remove espaco repetido.
3. O status foi confirmado em 2026-10-27 (validacao em tela dos rotulos em `agreements.reference`), entao `agreements` nao fica mais bloqueado por `mapping_not_confirmed` e `installments`/`payments` voltam a carregar sem flag. Como os 1.505 acordos ja existem e sao reusados pela chave legada, `reference` so e preenchida numa rodada com `--commit --enrich-reused` (o `UPDATE` usa `COALESCE(coluna, %s)` e nunca sobrescreve valor existente); a rodada padrao de 2026-10-27 nao preencheu nenhuma.

## Classe B - herdam a decisao de 2026-09-25 (10)

| Aba | Colunas | Evidencia | Proposta |
|---|---|---|---|
| `TBL_DIVIDA` | `ID`, `Divida.Aluno.ID`, `Divida_Nome`, `Divida.Pagamento.ID`, `Divida.ValorOriginalTotal`, `Divida.ValorAtualizadoTotal` | `docs/CANONICAL_LOAD_REPORT.md`: `TBL_DIVIDA | no_mapping | 6.868` linhas, 0 carregadas | `defer: no_canonical_destination`, mantendo o gap `agreements_source_resolution` com nota reescrita |
| `TBL_DIVIDA_LISTAGEM` | `Divida_Listagem.Divida.ID`, `Divida_Listagem.Vencimento`, `Divida_Listagem.Valor`, `Divida_Listagem.Valor_Atualizado` | idem: `42.886` linhas, 0 carregadas | `defer: no_canonical_destination` |

O gap `agreements_source_resolution` deixou de ser duvida: `agreements` sai de `TBL_PAGAMENTO` (`provides_legacy_id_for: agreements`, 1.572 linhas -> 1.505 acordos) e `installments` de `TBL_PAGAMENTO_LISTAGEM` (15.535 -> 15.259) desde a decisao do operador em 2026-09-25. Falta registrar isso no dicionario em vez de repetir `pending_policy` em dez colunas: dividas que nunca viraram acordo ficam fora do canonico ate existir modelo de inadimplencia.

## Classe C - politica de identidade, reaberta pela `0011` (2)

| Aba | Coluna | Evidencia | Destino decidido |
|---|---|---|---|
| `TBL_ALUNO` | `Aluno.Responsavel_Financeiro` | 6.350 preenchidos, 5.828 nomes distintos, 5.352 usados por um aluno so; 380 nomes coincidem com `customers.full_name` mas 111 casam com 2+ clientes | `map: guardians.full_name` (`confirmed` em 2026-10-27): o nome vira o guardiao do aluno, nunca um cliente |
| `TBL_ALUNO` | `Aluno.CPFResponsavel` | 6.651 preenchidos: 5.560 validos, 1.084 invalidos (`DOCUMENT_INVALID`), 5.095 distintos, 424 compartilhados por 2+ alunos | `map: guardians.document_number` (`confirmed` em 2026-10-27): documento do guardiao, gravado como esta na origem e nunca usado para vincular `customers` |

Essas duas eram a guarda do dicionario: `scripts/test_build_field_dictionary.py::test_open_decisions_stay_blocked` exigia `unreliable_document_source` e `name_only_link_not_allowed` como itens de politica. Com `guardians` a guarda mudou de lugar e depois foi aprovada: `test_class_c_reopens_with_guardians` e `test_student_contacts_load_is_confirmed` exigem `map` + `confirmed` nas 10 colunas, e `test_no_mapping_is_left_unconfirmed` exige que o portao nao volte a listar `MAPPING_NOT_CONFIRMED`.

### Evidencia medida no lote `4609c071` (2026-10-27)

Leitura somente leitura de `migration_rows` (`source_sheet = 'TBL_ALUNO'`) cruzada com `students` e `customers`. Cobertura das duas colunas em 6.652 linhas: 6.350 com nome (95,5%), 6.644 com CPF (99,9%), 6.343 com os dois, 7 so com nome e 1 sem nenhum.

| Metrica | Valor |
|---|---:|
| Nomes de responsavel preenchidos | 6.350 |
| Nomes distintos (texto original) | 5.828 |
| Nomes usados por um aluno so | 5.352 |
| CPFs preenchidos | 6.644 |
| CPFs validos (digito verificador) | 5.560 |
| CPFs invalidos (`DOCUMENT_INVALID`) | 1.084 |
| CPFs validos distintos | 5.095 |
| CPFs validos usados por 2+ alunos | 424 (889 alunos, maximo 4 por CPF) |
| CPFs validos com 2+ grafias de nome | 45 |
| Alunos com `customer_id` hoje | 0 de 6.641 |

O que decide a politica nao e o volume, e o estado do lado canonico:

1. **Nao existe nenhum CPF em `customers`.** Os 2.138 preenchimentos de `document_number` sao todos de 14 digitos (CNPJ) e todos vem de `TBL_CLIENTE`; zero CPF de 11 digitos. Logo o cruzamento CPF do responsavel x `customers.document_number` da **0 alunos vinculaveis**: qualquer politica de CPF cria cadastro novo, nao reaproveita cliente.
2. **O pagador dos acordos hoje e o aluno, nao o responsavel.** Os 1.568 clientes criados de `TBL_PAGAMENTO` nao tem documento e foram nomeados com `Pagamento.Nome_Aluno`; 1.123 desses nomes batem exatamente com `students.full_name`, e os 1.505 acordos apontam para eles. Criar cliente a partir do CPF do responsavel produziria um segundo cadastro da mesma relacao economica, sem chave de reconciliacao com o primeiro.
3. **Nome nao desempata.** 380 nomes de responsavel coincidem com algum `customers.full_name` (395 alunos), mas 111 desses nomes casam com 2+ clientes; e 45 CPFs validos aparecem com 2+ grafias (`SILVIA ASSIS VIEIRA.` x `SILVIA ASSIS VIEIRA`, `ELAINE CRISTINA ROCHA` x `ELAINE CRISTINA ROCHA DE ALBUQUERQUE`), o que e ruido de digitacao, nao homonimia. As duas condicoes de um vinculo "seguro" (CPF valido nao compartilhado + nome concordante) existem em 0 alunos quando o alvo e `customers`.
4. **O caminho sem CPF tambem e parcial.** 1.153 alunos (17,4%) tem ao menos um acordo com cliente resolvido - esse vinculo ja esta no canonico via `agreements.student_id` + `agreements.customer_id`, e 245 desses alunos tem 2+ clientes distintos entre acordos (o mesmo aluno virou clientes diferentes por variacao de grafia no pagamento). Os 5.488 alunos restantes nao tem lado financeiro carregado.
5. **O responsavel e uma pessoa, nao um cliente comercial.** No Dataverse (`_legacy-powerapps/.../DataSources/TBL_ALUNO.json`) o responsavel tem `cr04f_cpfdoresponsavel`, `cr04f_rgdoresponsavel`, `cr04f_profissaodoresponsavel`, `cr04f_estadocivildoresponsavel` e `cr04f_telefonedoaluno`; o canonico nao tem entidade de guardiao - `customers` e a tabela de quem paga contrato/escola, e o contato do aluno so ganhou tabela na `0010` (`student_contacts`, carga ainda pendente).

**Decisao (2026-10-27):** as duas colunas continuam em `review` e nao entram na carga - nenhuma linha muda, nenhum cliente novo nasce e `students.customer_id` segue vazio. O vinculo do responsavel reabre quando existir `guardians` (ou equivalente) ao lado de `student_contacts` - a `0010` entregou `student_contacts`, o guardiao fica para a migration seguinte -, e ai o destino deixa de ser `customers`. Consultas de reproducao em `## Reproducao das consultas`.

**Reabertura (2026-10-27, migration `0011`):** `guardians` existe, entao a condicao foi cumprida e as duas colunas sairam de `review`. O que muda na pratica:

1. O destino **nao** e `customers`: `Aluno.Responsavel_Financeiro` vira `guardians.full_name` e `Aluno.CPFResponsavel` vira `guardians.document_number`, sempre com `customer_id` nulo e `is_verified` falso. Nenhum cliente novo nasce e `students.customer_id` continua vazio.
2. Os outros atributos do responsavel que a origem ja tem (`Aluno_RGResponsavel`, `Aluno_ResponsavelEstadoCivil`, `Aluno_ResponsavelProfissao`) saem do gap `students_guardian_details` e entram em `guardians.document_rg`/`marital_status`/`occupation`, tambem confirmados em 2026-10-27.
3. A carga entrou como `proposed` e foi **confirmada pelo operador em 2026-10-27**: `6.347` guardioes gravados (294 linhas sem nome e 11 sem aluno ficam de fora). Sem a confirmacao, `guardians` ficava `blocked: mapping_not_confirmed` e nada era gravado.
4. A duvida que existia sobre o **nome** nao bloqueia mais a carga e continua aberta para a conciliacao assistida: 380 nomes de responsavel coincidem com `customers.full_name` e 111 desses casam com 2+ clientes. Como o guardiao nao aponta para `customers`, isso so decide se o guardiao pode ser promovido a cliente depois.

A evidencia que sustentava o bloqueio continua valida e explica por que o destino e `guardians` e nao `customers`:

## Classe D - exigem migration nova (6)

| Aba | Coluna | Gap | Volume no lote | O que a migration precisa |
|---|---|---|---:|---|
| `TBL_CLIENTEENDTEL` | `ID` | `contacts_legacy_id` | 54.782 ids; 46.829 contatos carregados | **resolvido**: `contacts.legacy_*` + indice unico na `0009`, carimbado pelo backfill e mapeado com `provides_legacy_id_for: contacts` |
| `TBL_PAGAMENTO_LISTAGEM` | `ID` | `installments_legacy_id` | 15.535 ids distintos; 15.259 parcelas carregadas | **resolvido**: `installments.legacy_*` + indice unico na `0009`, carimbado pelo backfill e mapeado com `provides_legacy_id_for: installments` |
| `TBL_PAGAMENTO` | `Pagamento_DataFechamento` | `agreements_closed_at` | 1.497 de 1.572 preenchidos | **schema resolvido na `0010`**: `agreements.closed_at`; a coluna fica em `review: pending_policy` ate definir se a data e fechamento do acordo ou assinatura |
| `TBL_ENDTEL` | `ENDTEL_ALUNO_ID` | `students_contact` | 47.562 linhas, 6.894 alunos, 44.764 com aluno resolvido | **resolvido, carregado e confirmado na `0011`**: `student_contacts` (0010) ganhou `status` e a aba virou entidade com `type`/`value`/`is_primary`/`status`, aprovados em 2026-10-27; `contacts` nao servia porque `customer_id` e `NOT NULL` |
| `TBL_USER` | `ID` | `users_legacy_import` | 28 usuarios | **schema resolvido na `0010`**: `users.legacy_*` + indice unico; a entrada continua presa a politica de credencial (`password_hash` e `NOT NULL` e a senha do legado nao migra) |
| `TBL_DIVIDA_LISTAGEM` | `ID` | `installments_legacy_id` | 42.886 ids distintos | **fechado pela classe B**: com a aba fora do canonico a coluna virou `defer: no_canonical_destination` e nao precisa de coluna nova |

A `0009` foi deliberadamente estreita: so os dois `legacy_id` que davam rastreabilidade a 62.088 linhas ja carregadas. A `0010` fechou o schema das tres lacunas restantes (`agreements.closed_at`, `student_contacts`, `users.legacy_*`) sem mexer na carga. A `0011` fez o passo seguinte em duas das tres: `student_contacts` passou a ser carregado de `TBL_ENDTEL` e a entidade `guardians` nasceu para a classe C. `agreements.closed_at` continua sem carga (semantica de fechamento) e `users.legacy_*` continua preso a politica de credencial - sao as duas ultimas colunas em `review`.

O que a `0011` mediu em `TBL_ENDTEL`, alem do tipo:

| Metrica | Valor |
|---|---:|
| Linhas na aba | 47.562 |
| Com tipo **e** valor (carregaveis) | 41.117 |
| Com tipo e valor vazio | 457 |
| Sem tipo, sem valor e sem status | 5.988 |
| E-mails com `@` rotulados fora de `EMAIL` | 252 (0,6%) |
| `EMAIL` sem `@` | 13 |
| `TELEFONE` com letra / com virgula | 5 / 1 |
| Contatos gravados (aluno resolvido) | 38.962 |
| Linhas com aluno fora da carga | 2.797 |

## Classe E - endereco de escola: semantica clara, falta tabela (6)

| Aba | Colunas | Evidencia |
|---|---|---|
| `TBL_AUXSUBIR` | `Endereco`, `Numero`, `Complemento`, `Bairro`, `Municipio`, `CEP` | 9.553 linhas; endereco completo e coerente (ex. `STEFANO SANTO | 118 | VILA ISOLINA MAZZEI | SAO PAULO | 2084030`), 7.905 CEPs distintos, nenhum vazio |

Proposta: `defer: address_not_modeled`, mantendo o gap `schools_contact_address`. Duas ressalvas registradas:

1. `schools` nao tem endereco e `contacts` exige `customer_id`, entao nao ha destino hoje.
2. 5.922 dos 9.553 CEPs tem 7 digitos - o zero a esquerda se perdeu na exportacao. Quem consumir precisa completar para 8 digitos; nao e problema de mapeamento, e de normalizacao na origem.


## Impacto no portao de aprovacao

| Cenario | Colunas `review` | Itens no portao | `db:field-dictionary-check` |
|---|---:|---:|---|
| Antes da triagem | 31 | 31 | exit `2` (aprovacao bloqueada) |
| A (6) + B (10) + E (6) aplicadas | 8 | 8 | exit `2` |
| + `0009` + backfill (`contacts`/`installments.legacy_id`) | 6 | 6 | exit `2` |
| + A' com `status: "proposed"` | 5 | 6 (5 `review` + 1 `MAPPING_NOT_CONFIRMED`) | exit `2` |
| + `0010` (schema da classe D, com as 3 colunas ainda em `review`) | 5 | 6 | exit `2` |
| + `0011` (classe C reaberta + carga de `TBL_ENDTEL`, tudo `proposed`) | 2 | 13 (11 `MAPPING_NOT_CONFIRMED` + 2 `REVIEW_REQUIRED`) | exit `2` |
| + A' confirmada (2026-10-27) | 2 | 12 | exit `2` |
| + `guardians` e `student_contacts` confirmados (2026-10-27) | 2 | 2 (so `REVIEW_REQUIRED`) | exit `2` |
| + decisoes de 2026-10-27 (`DataFechamento`, `TBL_USER.ID` e `asaas_charges`) | 0 | 0 | exit `0` - **estado atual** |

Numeros medidos no estado atual: `46 map`, `79 ignore`, `731 defer`, `0 review`, `0` problema estrutural, `0` divergencia de staging, `1` aviso (`MULTIPLE_LEGACY_ID_PROVIDERS` em `customers`); o portao nao lista nada (`policy_items = 0`) e a carga sai `exit 0` com 10 tabelas prontas.

O portao nao bloqueia a carga canonica: `scripts/load_canonical_batch.py` so exige que toda coluna `NOT NULL` sem `default` esteja coberta por `map`/`links`, e recusa `map` com `status` diferente de `confirmed` (`MAPPING_NOT_CONFIRMED`). Com as tres decisoes de 2026-10-27, o dicionario nao tem mais nenhuma pendencia de decisao.

## Como foi aplicado

1. `scripts/legacy_field_map.json`: classes A, B, E e A' reescritas com nota de evidencia por coluna (nenhum `map` existente mudou).
2. `apps/api/migrations/0009_contacts_installments_legacy_provenance.sql` + `npm run db:migrate` (local: `Migrations: 1 aplicadas, 8 ja aplicadas`).
3. `python scripts\backfill_legacy_provenance.py --commit`: `contacts` 46.829 carimbados (7.953 fora do canonico), `installments` 15.259 carimbados (276 fora do canonico), 0 divergencias; segunda rodada `0` a carimbar.
4. `TBL_CLIENTEENDTEL.ID` e `TBL_PAGAMENTO_LISTAGEM.ID` passaram a `map` com `provides_legacy_id_for` (dependem do passo 3: sem o carimbo, a carga tentaria reinserir as linhas ja gravadas e bateria na chave natural de `installments`).
5. Revalidacao:

   ```powershell
   npm run db:field-dictionary      # 39 map, 78 ignore, 734 defer, 5 review
   npm run db:field-dictionary-check # exit 2, 5 REVIEW_REQUIRED + 1 MAPPING_NOT_CONFIRMED, staging_mismatches 0
   npm run test:python              # 205 testes
   python scripts\load_canonical_batch.py --allow-proposed agreements --json-out "$env:TEMP\voa_load.json"
   ```

   A carga em `dry-run` reusou todas as linhas (`inserted=0`, `reused=104.709`) e `canonical_before == canonical_after` em todas as tabelas: e a prova de que o backfill fechou a reconciliacao por chave legada. Sem `--allow-proposed agreements` a mesma rodada bloqueia `agreements` (`mapping_not_confirmed`) e derruba `installments`/`payments` por dependencia, reusando `80.929` linhas - a flag e obrigatoria enquanto `Pagamento_Nome` estiver `proposed`.

   As migrations tambem foram verificadas do zero e de forma repetida: `npm run test:integration` com `TEST_DATABASE_URL` no Postgres local roda `applyMigrations` num schema temporario e passou com `21` testes (ou seja, `0001..0009` aplicam em banco vazio), e `npm run db:migrate` no banco existente reporta `0 aplicadas, 9 ja aplicadas`.

6. `apps/api/migrations/0010_class_d_schema_gaps.sql` (2026-10-27) + `npm run db:migrate` (`Applied migration 0010_class_d_schema_gaps.sql`, segunda rodada sem nada a aplicar). Verificacao em tres frentes: `\d student_contacts` (12 colunas, FK `ON DELETE CASCADE` para `students`, chave unica `(legacy_source, legacy_table, legacy_id)`), `agreements.closed_at` e `users.legacy_*` + `users_legacy_key_idx` presentes; aplicacao do zero num banco vazio (`voa_migtest`: os 10 arquivos em ordem, sem erro, depois `drop database`); e a carga `--allow-proposed agreements` inalterada (`considered=121.991`, `loaded=104.709`, `inserted=0`, exit `4` pelo `asaas_charges`).

7. `apps/api/migrations/0011_guardians_and_student_contact_status.sql` (2026-10-27) + `npm run db:migrate` (`Applied migration 0011_guardians_and_student_contact_status.sql`). Verificacao: `guardians` com 16 colunas (FK `ON DELETE CASCADE` para `students`, `customer_id` nullable, indices `guardians_student_idx`/`guardians_customer_idx`, chave unica legada) e `student_contacts.status NOT NULL DEFAULT 'active'`; aplicacao do zero num banco vazio (os 11 arquivos em ordem, sem erro); dicionario revalidado (`50 map`, `79 ignore`, `725 defer`, `2 review`, `structural_issues: 0`, `staging_mismatches: 0`, exit `2` com 13 itens) e `test:python` com `214` testes (esse e o estado de entao; depois da aprovacao do passo 8 o portao fica com 2 itens e a suite com 215 testes).

   Carga medida ainda com `--allow-proposed agreements,guardians,student_contacts` (as flags sairam no passo 8):

   - `guardians`: 6.347 gravados, 294 sem `Aluno.Responsavel_Financeiro`, 11 sem aluno (`LOAD_ROW_LINK_UNRESOLVED`);
   - `student_contacts`: 38.962 gravados, 2.797 com aluno fora da carga, 5.389 sem tipo, 413 sem valor (5.695 dos gravados ficaram `inactive`);
   - segunda rodada `inserted=0`, `reused=150.018` (chave legada de `TBL_ENDTEL` e de `TBL_ALUNO` segurando a idempotencia).

8. `scripts/legacy_field_map.json` (2026-10-27): aprovacao do operador - os 11 `proposed` (`Pagamento_Nome`, as 5 de `guardians` e as 5 de `student_contacts`) viraram `status: "confirmed"`. Nenhuma coluna mudou de destino, so o status.

   - `npm run db:field-dictionary` -> `50 map / 79 ignore / 725 defer / 2 review`, `0` problema estrutural; `npm run db:field-dictionary-check` -> exit `2` com **2 `REVIEW_REQUIRED`** e nenhum `MAPPING_NOT_CONFIRMED`;
   - `npm run test:python` -> `215` testes (as assercoes de `proposed` viraram assercoes de `confirmed`, mais um teste que exige zero `MAPPING_NOT_CONFIRMED` no portao);
   - rodada padrao, **sem nenhuma flag** (`python scripts\load_canonical_batch.py --commit`): `considered=176.205`, `loaded=150.018`, `inserted=0`, `reused=150.018`, exit `4` so pelo `asaas_charges`;
   - `agreements.reference` continua `NULL` nas 1.505 linhas locais porque elas sao reusadas pela chave legada: o valor entra na insercao (banco novo, como o Supabase) ou numa rodada com `--commit --enrich-reused`.

Ordem obrigatoria para qualquer ambiente novo: `db:migrate` (0009, 0010 e 0011) -> `db:backfill-legacy-provenance --commit` -> carga. Habilitar o provedor antes do backfill faz a carga recusar as linhas existentes como duplicidade.

Exemplo de edicao por classe (linha atual -> proposta):

```jsonc
// Classe A - TBL_ALUNO
{ "match": "Aluno_AnoDivida", "defer": "no_canonical_destination", "note": "ano de referencia da divida (2014..2022, com 1900/1969 invalidos); agreements nao tem coluna de ano" },
{ "match": "Aluno_Contrato", "ignore": "legacy_flag", "note": "booleano: 3754 false, 1 true, 2897 vazios" },

// Classe A' (aplicada em 2026-10-22, confirmada em 2026-10-27) - TBL_PAGAMENTO
{ "match": "Pagamento_Nome", "map": "agreements.reference", "type": "text", "normalization": "collapse_ws", "status": "confirmed", "note": "rotulo do lote de acordo ('Acordo 2024'); nao identifica o acordo, isso e agreements.legacy_id" },

// Classe B - TBL_DIVIDA
{ "match": "ID", "defer": "no_canonical_destination", "gap": "agreements_source_resolution", "note": "TBL_DIVIDA fora do canonico: agreements vem de TBL_PAGAMENTO (decisao 2026-09-25)" },

// Classe E - TBL_AUXSUBIR
{ "match": "Endereco", "defer": "address_not_modeled", "gap": "schools_contact_address" }
```

## Decisoes pedidas ao operador

1. **Classe A (6 colunas)** - **aceita** em 2026-10-22: `ignore`/`defer` como acima. Sao as unicas seis em que a semantica ficou evidente pelo dado (`Aluno_AnoDivida` e inferencia: "ano de referencia da divida").
2. **Classe A' (`Pagamento_Nome`)** - **aceita** em 2026-10-22 como `map: agreements.reference` e **confirmada em 2026-10-27** apos a validacao da coluna em tela: `status: "confirmed"`, sem `MAPPING_NOT_CONFIRMED` no portao e sem `--allow-proposed agreements` na carga. O valor entra em `agreements.reference` na insercao (banco novo) ou numa rodada `--commit --enrich-reused` para linhas ja gravadas (o `UPDATE` usa `COALESCE(coluna, %s)`, ou seja, nunca sobrescreve valor existente).
3. **Classe B (10 colunas)** - **aceita** em 2026-10-22: `TBL_DIVIDA`/`TBL_DIVIDA_LISTAGEM` registradas como fora do canonico (inadimplencia nao modelada) e gap `agreements_source_resolution` reescrito como resolvido. Se um dia dividas entrarem no canonico, o caminho e nova entidade `debts` + `debt_items` e as 10 colunas voltam a `map`.
4. **Classe E (6 colunas)** - **aceita** em 2026-10-22: `defer: address_not_modeled`. Quando endereco de escola entrar, o caminho e migration de `school_addresses` (com CEP normalizado para 8 digitos); o `defer` de hoje nao impede.
5. **Classe C (2 colunas)** - **reaberta e confirmada em 2026-10-27 pela `0011`**: com a entidade `guardians`, as duas colunas viraram `map` (`guardians.full_name` e `guardians.document_number`) e o status foi confirmado pelo operador no mesmo dia. O registro da decisao anterior (mantidas em `review` em 2026-10-27, porque nenhum dos 5.095 CPFs validos existe em `customers` e nome nao desempata) fica como a justificativa de **nao** apontar para `customers`. A carga entra na rodada padrao; `customer_id` nulo e `is_verified` falso.
6. **Classe D** - **schema fechado** em 2026-10-27: a `0009` saiu so com `installments.legacy_id` + `contacts.legacy_id` (as duas que davam rastreabilidade ao que ja estava carregado) e a `0010` criou `agreements.closed_at`, `student_contacts` e `users.legacy_*`. A `0011` fechou a carga do contato do aluno (`TBL_ENDTEL` -> `student_contacts`, confirmada em 2026-10-27) e adicionou `student_contacts.status`. Restam em `review` duas colunas de origem por decisao de produto, nao por falta de destino: `Pagamento_DataFechamento` (fechamento x assinatura) e `TBL_USER.ID` (politica de credencial). Sem elas o portao fica em `2`, mas nada impede a operacao das telas.

## Reproducao das consultas

Tudo somente leitura, no container `voa-staging` (Postgres local):

```powershell
@"
select coalesce(payload->>'Aluno_AnoDivida','<null>') as valor, count(*)
from migration_rows where source_sheet = 'TBL_ALUNO' group by 1 order by 2 desc;
select coalesce(payload->>'Pagamento_Nome','<null>') as valor, count(*)
from migration_rows where source_sheet = 'TBL_PAGAMENTO' group by 1 order by 2 desc;
select count(*) filter (where length(payload->>'CEP') = 7) as cep_7,
       count(*) filter (where length(payload->>'CEP') = 8) as cep_8
from migration_rows where source_sheet = 'TBL_AUXSUBIR';
"@ | Set-Content "$env:TEMP\triage_probe.sql" -Encoding ascii
Get-Content "$env:TEMP\triage_probe.sql" | docker exec -i voa-staging psql -U postgres -d voa_staging -A -F '|'
```

Os volumes por aba e o `no_mapping` de `TBL_DIVIDA` saem de `docs/CANONICAL_LOAD_REPORT.md`; os gaps por coluna saem de `docs/FIELD_MAPPING_DICTIONARY.md`.

### Classe C

A cobertura das duas colunas e a validade do CPF vem do payload do lote; o cruzamento com o canonico sai direto das tabelas:

```sql
-- cobertura e nomes (o CPF valido/invalido e recalculado no cliente, ver abaixo)
select count(*) as linhas,
       count(*) filter (where payload->>'Aluno.Responsavel_Financeiro' is not null) as com_nome,
       count(*) filter (where payload->>'Aluno.CPFResponsavel' is not null) as com_cpf
from migration_rows where source_sheet = 'TBL_ALUNO';

-- nenhum CPF em customers: os documentos existentes sao CNPJ de TBL_CLIENTE
select legacy_table, length(document_number) as digitos, count(*)
from customers where deleted_at is null and document_number is not null
group by 1, 2 order by 3 desc;

-- o pagador dos acordos e o aluno: 1.123 nomes batem com students.full_name
select count(*) from students s where s.deleted_at is null and exists (
  select 1 from customers c
  where c.legacy_table = 'TBL_PAGAMENTO'
    and upper(btrim(c.full_name)) = upper(btrim(s.full_name)));

-- cobertura do vinculo alternativo (pelo acordo ja carregado)
select count(distinct student_id) from agreements
where student_id is not null and deleted_at is null;
```

O digito verificador e a contagem de grafias por CPF usam `is_valid_cpf`/`only_digits` de `scripts/validate_staging_batch.py` sobre `migration_rows` (`source_sheet = 'TBL_ALUNO'`); o resultado de 2026-10-27 esta na tabela da classe C.

### Classe D

Os numeros da `0010`/`0011` saem do payload de `TBL_ENDTEL` (tipo/status/principal) e do cruzamento com `students.legacy_id`:

```sql
-- volume por tipo (5.988 linhas sem tipo e sem status: as mesmas linhas)
select coalesce(payload->>'ENDTEL_TIPO','<vazio>') as tipo, count(*)
from migration_rows where source_sheet = 'TBL_ENDTEL' group by 1 order by 2 desc;

-- cruzamento tipo x valor: 41.117 com tipo e valor, 457 com tipo e valor vazio, 5.988 sem os dois
select nullif(btrim(payload->>'ENDTEL_TIPO'),'') is null as sem_tipo,
       nullif(btrim(payload->>'ENDTEL_VALOR'),'') is null as sem_valor,
       count(*)
from migration_rows where source_sheet = 'TBL_ENDTEL' group by 1, 2 order by 1, 2;

-- o rotulo de tipo e confiavel? 252 e-mails (@) fora de EMAIL, 13 EMAIL sem @, 5 TELEFONE com letra, 1 com virgula
with e as (
  select upper(btrim(coalesce(payload->>'ENDTEL_TIPO',''))) as tipo,
         btrim(coalesce(payload->>'ENDTEL_VALOR','')) as valor
  from migration_rows
  where source_sheet = 'TBL_ENDTEL' and nullif(btrim(payload->>'ENDTEL_VALOR'),'') is not null
)
select count(*) as com_valor,
       count(*) filter (where tipo = 'EMAIL' and position('@' in valor) = 0) as email_sem_arroba,
       count(*) filter (where tipo <> 'EMAIL' and position('@' in valor) > 0) as arroba_fora_de_email,
       count(*) filter (where tipo = 'TELEFONE' and valor ~ '[A-Za-z]') as telefone_com_letra,
       count(*) filter (where tipo = 'TELEFONE' and position(',' in valor) > 0) as telefone_com_virgula
from e;

-- status e flag principal
select coalesce(payload->>'ENDTEL_STATUS','<vazio>') as status, count(*)
from migration_rows where source_sheet = 'TBL_ENDTEL' group by 1 order by 2 desc;
select coalesce(payload->>'ENDTEL_PRINCIPAL','<vazio>') as principal, count(*)
from migration_rows where source_sheet = 'TBL_ENDTEL' group by 1 order by 2 desc;

-- quantas linhas acham o aluno canonico (44.764 de 47.562 em 6.894 alunos)
select count(distinct payload->>'ENDTEL_ALUNO_ID') as alunos,
       count(*) filter (where payload->>'ENDTEL_ALUNO_ID' in (select legacy_id from students)) as com_aluno
from migration_rows where source_sheet = 'TBL_ENDTEL';

-- TBL_ALUNO.Telefone e copia esparsa: 535 preenchidos contra 23.015 telefones em TBL_ENDTEL
select count(*) from migration_rows
where source_sheet = 'TBL_ALUNO' and coalesce(payload->>'Aluno.Telefone','') <> '';

-- TBL_ALUNO.Endereco idem, e o valor costuma ser o mesmo de um ENDTEL_VALOR (349 de 442)
select count(*) as com_endereco,
       count(*) filter (where exists (
         select 1 from migration_rows e
         where e.source_sheet = 'TBL_ENDTEL'
           and btrim(e.payload->>'ENDTEL_VALOR') = btrim(a.payload->>'Aluno.Endereco'))) as igual_endtel
from migration_rows a
where a.source_sheet = 'TBL_ALUNO' and coalesce(a.payload->>'Aluno.Endereco','') <> '';
```

A conferencia do schema aplicado (colunas, FK e indices da `0010`):

```sql
\d student_contacts
select column_name, data_type, is_nullable from information_schema.columns
where table_name in ('student_contacts') order by ordinal_position;
select version from schema_migrations order by version;
```

