# Dicionario de campos do legado (fase 2)

Gerado por `scripts/build_field_dictionary.py` a partir de `VOA.xlsx` e do schema real em `apps/api/migrations/*.sql`.
Este relatorio nao grava nada no banco e nao cria registros canonicos.

## Resumo

| Metrica | Valor |
|---|---:|
| Abas inventariadas | 60 |
| Colunas inventariadas | 856 |
| Colunas com `map` | 50 |
| Colunas `ignore` | 79 |
| Colunas `defer` | 725 |
| Colunas `review` | 2 |
| Colunas `unmapped` | 0 |
| Problemas estruturais | 0 |
| Itens de politica pendentes | 2 |

## Portao de aprovacao

- Estrutural: OK. Todo mapa aponta para tabela/coluna existente no schema canonico.
- Aprovacao: BLOQUEADA (2 item(ns) `review` ou mapeamento nao confirmado). Nenhuma carga canonica pode rodar antes da decisao de negocio.

## Conferencia staging x workbook

| Aba | Tipo | Linhas no lote | Faltando no staging | Extra no staging |
|---|---|---:|---:|---:|
| TBL_EMAILLISTACONTATO | empty_sheet | 0 | 6 | 0 |

## Provedores de `legacy_id` por tabela canonica

| Tabela | Coluna provedora |
|---|---|
| agreements | TBL_PAGAMENTO.ID |
| contacts | TBL_CLIENTEENDTEL.ID |
| customers | TBL_CLIENTE.ID, TBL_PAGAMENTO.ID |
| guardians | TBL_ALUNO.ID |
| installments | TBL_PAGAMENTO_LISTAGEM.ID |
| schools | TBL_ESCOLA.ID |
| student_contacts | TBL_ENDTEL.ID |
| students | TBL_ALUNO.ID |

## Vinculos resolvidos na mesma linha

| Aba | Coluna canonica | Origem dentro da linha |
|---|---|---|
| TBL_ALUNO | `guardians.student_id` | `row:students` |
| TBL_PAGAMENTO | `agreements.customer_id` | `row:customers` |
| TBL_PAGAMENTO | `asaas_customers.customer_id` | `row:customers` |
| TBL_PAGAMENTO_LISTAGEM | `asaas_charges.installment_id` | `row:installments` |
| TBL_PAGAMENTO_LISTAGEM | `payments.installment_id` | `row:installments` |

## Abas mapeadas para entidade canonica

| Aba | Entidade | Colunas | map | ignore | defer | review |
|---|---|---:|---:|---:|---:|---:|
| TBL_ALUNO | `students` | 36 | 9 | 21 | 6 | 0 |
| TBL_CLIENTE | `customers` | 18 | 3 | 1 | 14 | 0 |
| TBL_CLIENTEENDTEL | `contacts` | 5 | 4 | 1 | 0 | 0 |
| TBL_DIVIDA | `agreements` | 10 | 0 | 3 | 7 | 0 |
| TBL_DIVIDA_LISTAGEM | `agreements` | 11 | 0 | 4 | 7 | 0 |
| TBL_ENDTEL | `student_contacts` | 9 | 6 | 2 | 1 | 0 |
| TBL_ESCOLA | `schools` | 16 | 5 | 5 | 6 | 0 |
| TBL_PAGAMENTO | `agreements` | 24 | 6 | 7 | 10 | 1 |
| TBL_PAGAMENTO_LISTAGEM | `installments` | 34 | 17 | 13 | 4 | 0 |
| TBL_USER | `users` | 13 | 0 | 3 | 9 | 1 |

## Detalhe por aba

### TBL_AGENDA

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 185 compromissos/tarefas do escritorio com vinculo a aluno, escola e processo.
- Colunas: 18 (map=0, ignore=0, defer=18, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | out_of_scope_operations |
| ID | defer |  |  |  |  |  | out_of_scope_operations |
| Agenda_Processo_ID | defer |  |  |  |  |  | out_of_scope_operations |
| Agenda_ProcessoNumero | defer |  |  |  |  |  | out_of_scope_operations |
| Agenda_DataInicio | defer |  |  |  |  |  | out_of_scope_operations |
| Agenda_Data | defer |  |  |  |  |  | out_of_scope_operations |
| Agenda_Hora | defer |  |  |  |  |  | out_of_scope_operations |
| Agenda_Obs | defer |  |  |  |  |  | out_of_scope_operations |
| Agenda_Login_ID_Criado | defer |  |  |  |  |  | out_of_scope_operations |
| Agenda_Status | defer |  |  |  |  |  | out_of_scope_operations |
| Agenda_Aluno_ID | defer |  |  |  |  |  | out_of_scope_operations |
| Agenda_Escola_ID | defer |  |  |  |  |  | out_of_scope_operations |
| Agenda_Tipo | defer |  |  |  |  |  | out_of_scope_operations |
| Agenda_Solicitante | defer |  |  |  |  |  | out_of_scope_operations |
| Agenda_ResponsavelRealizar | defer |  |  |  |  |  | out_of_scope_operations |
| Agenda_StatusArquivo | defer |  |  |  |  |  | out_of_scope_operations |
| Agenda_DataArquivoFinal | defer |  |  |  |  |  | out_of_scope_operations |
| Agenda_DataFimTarefa | defer |  |  |  |  |  | out_of_scope_operations |

### TBL_AGENDAENVIO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 8 envios de agenda com status de resposta.
- Colunas: 6 (map=0, ignore=0, defer=6, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | out_of_scope_operations |
| AGENDAENVIO_AGENDA_ID | defer |  |  |  |  |  | out_of_scope_operations |
| AGENDAENVIO_OBSERVACAO | defer |  |  |  |  |  | out_of_scope_operations |
| AGENDAENVIO_STATUSRESPOSTA | defer |  |  |  |  |  | out_of_scope_operations |
| AGENDAENVIO_RESPOSTA | defer |  |  |  |  |  | out_of_scope_operations |
| ID | defer |  |  |  |  |  | out_of_scope_operations |

### TBL_ALUNO

- Entidade canonica: students
- Tipo de linha: entity
- Observacoes: 6.652 alunos. students.enrollment_number e students.document_number ficam vazios: TBL_ALUNO nao tem matricula nem documento do aluno. A mesma linha alimenta `guardians` (reabertura da classe C pela 0011, confirmada pelo operador em 2026-10-27): o responsavel nao vira `customers`, vira guardiao do aluno, com `customer_id` nulo e `is_verified` falso.
- Colunas: 36 (map=9, ignore=21, defer=6, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | ignore |  |  |  |  |  | denormalized_display_name |
| Aluno_AnoDivida | defer |  |  |  |  |  | ano de referencia da divida (2014..2022, com 1900 em 19 linhas e 1969 em 2): agreements e students nao tem coluna de ano; 5.066 vazios em 6.652 |
| ID | map | students.legacy_id | legacy_id | trim | sim |  |  |
| Aluno.Escola.ID | map | students.school_id | reference | trim | sim | schools | resolve schools.legacy_id; 6.651 preenchidos em 72 escolas |
| Aluno.Nome | map | students.full_name | name | collapse_ws | sim |  |  |
| Aluno.Responsavel_Financeiro | map | guardians.full_name | name | collapse_ws | sim |  | 6.350 preenchidos, 5.828 nomes distintos, 5.352 usados por um aluno so. Nome nunca identifica cliente: vira o nome do guardiao, sem vinculo com customers (380 nomes coincidem com customers.full_name e 111 casam com 2+ clientes) |
| Aluno.Telefone | ignore |  |  |  |  |  | 535 preenchidos em 6.652: copia esparsa do telefone do aluno, e TBL_ENDTEL e a fonte (23.015 telefones em 6.894 alunos) que carrega student_contacts |
| Created | ignore |  |  |  |  |  | legacy_audit_only |
| __PowerAppsId__ | ignore |  |  |  |  |  | empty_column |
| Aluno.Login.ID | defer |  |  |  |  |  | user_link_requires_review |
| Aluno.UltimoContato | ignore |  |  |  |  |  | 6.560 preenchidos, 688 datas distintas: data derivada do historico de contato |
| Aluno.CPFResponsavel | map | guardians.document_number | document | digits |  |  | 6.651 preenchidos: 5.560 validos, 1.084 invalidos (DOCUMENT_INVALID) e 5.095 distintos. Entra como documento do guardiao, nunca como chave de vinculo: nenhum desses CPFs existe em customers (os 2.138 documentos de la sao CNPJ de TBL_CLIENTE) e guardians.customer_id nasce nulo |
| Aluno.Endereco | ignore |  |  |  |  |  | 442 preenchidos em 6.652 e 349 deles sao identicos a um ENDTEL_VALOR: copia esparsa do endereco, que TBL_ENDTEL carrega em student_contacts |
| Aluno.Acordo | ignore |  |  |  |  |  | computed_cache |
| Aluno_Processo | ignore |  |  |  |  |  | computed_cache |
| Aluno_Ativo | map | students.status | code | value_map_ci | sim |  | 6.538 preenchidos; vazio nao pode virar inativo automaticamente [valores: sim->active, nao->inactive] |
| Aluno.PesquisaContato | ignore |  |  |  |  |  | 6.148 preenchidos com valor constante |
| Aluno_MotivoInativo | defer |  |  |  |  |  | no_canonical_destination |
| Aluno_Qtdivida | ignore |  |  |  |  |  | computed_cache |
| Aluno_QtAcordo | ignore |  |  |  |  |  | computed_cache |
| Aluno_QtProcesso | ignore |  |  |  |  |  | computed_cache |
| Aluno_StatusDivida | ignore |  |  |  |  |  | computed_cache |
| Aluno_StatusAcordo | ignore |  |  |  |  |  | computed_cache |
| Aluno_MotivoDivida | defer |  |  |  |  |  | no_canonical_destination |
| Aluno_Responsavel | defer |  |  |  |  |  | 16 valores distintos; provavel usuario interno responsavel |
| Aluno_MinDataDivida | ignore |  |  |  |  |  | menor vencimento das parcelas: recalcular a partir de installments |
| Aluno_DividaStatus | ignore |  |  |  |  |  | computed_cache |
| Aluno_Comentario | defer |  |  |  |  |  | no_canonical_destination |
| Aluno_Quitado | ignore |  |  |  |  |  | computed_cache |
| Attachments | ignore |  |  |  |  |  | attachment_metadata |
| Aluno_DocPai | ignore |  |  |  |  |  | 3.754 linhas, 1 valor distinto |
| Aluno_Contrato | ignore |  |  |  |  |  | flag contrato assinado sem uso pratico (1 true em 3.755 linhas, 2.897 vazios) e sem coluna em students |
| Aluno_DocSed | ignore |  |  |  |  |  | 3.652 linhas, 1 valor distinto |
| Aluno_RGResponsavel | map | guardians.document_rg | text | trim |  |  | 621 preenchidos em 6.652 (texto livre) |
| Aluno_ResponsavelEstadoCivil | map | guardians.marital_status | text | trim |  |  | 585 preenchidos, texto livre e sujo: 177 Casada, 175 Solteira, 99 Casado, 45 Divorciada, 40 solteiro, 13 Divorciado, 8 Uniao Estavel, 3 Viuvo, 3 Separada/Viuva, 2 Casa/separado e 1 cada em valores que nao sao estado civil (um CPF, um nome de pessoa, GARCOM, Desempregada, Comerciante, Vendedora, `.`). Entra como veio, sem traducao, para a revisao assistida classificar |
| Aluno_ResponsavelProfissao | map | guardians.occupation | text | collapse_ws |  |  | 585 preenchidos em 6.652 (texto livre) |

### TBL_AUXSEPARAR

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: helper
- Observacoes: Uma linha de planilha auxiliar de separacao de processo.
- Colunas: 3 (map=0, ignore=3, defer=0, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | ignore |  |  |  |  |  | staging_helper |
| AUXSEPARAR_SEPARACAOPROCESSO | ignore |  |  |  |  |  | staging_helper |
| ID | ignore |  |  |  |  |  | staging_helper |

### TBL_AUXSUBIR

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: helper
- Observacoes: 9.553 linhas de planilha auxiliar de carga com nome/endereco de escola. Unico lugar com endereco de escola em volume. Triagem de 2026-10-22: `Nome Escola2` e chave derivada (ignore) e as seis colunas de endereco ficam em `defer: address_not_modeled` ate existir tabela de endereco de escola; 5.922 CEPs perderam o zero a esquerda na exportacao.
- Colunas: 12 (map=0, ignore=5, defer=7, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | ignore |  |  |  |  |  | denormalized_display_name |
| contador | ignore |  |  |  |  |  | staging_helper |
| Nome Escola2 | ignore |  |  |  |  |  | chave derivada com ordem de palavras normalizada (DOM BOSCO COLEGIO para Colegio Dom Bosco): 9.099 distintos em 9.553 linhas, concilia com TBL_ESCOLA e nao e dado novo |
| Nome Social | defer |  |  |  |  |  | no_canonical_destination |
| Educ.Prof | ignore |  |  |  |  |  | constant_placeholder |
| Endereco | defer |  |  |  |  |  | logradouro da escola na planilha auxiliar (9.553 linhas); schools nao tem endereco e contacts exige customer_id [gap: schools_contact_address] |
| Numero | defer |  |  |  |  |  | numero do endereco da escola, completa Endereco e tambem nao tem tabela canonica [gap: schools_contact_address] |
| Complemento | defer |  |  |  |  |  | complemento do endereco da escola; sem tabela canonica [gap: schools_contact_address] |
| Bairro | defer |  |  |  |  |  | bairro do endereco da escola; sem tabela canonica [gap: schools_contact_address] |
| Municipio | defer |  |  |  |  |  | municipio do endereco da escola; sem tabela canonica [gap: schools_contact_address] |
| CEP | defer |  |  |  |  |  | 5.922 dos 9.553 CEPs tem 7 digitos: o zero a esquerda se perdeu na exportacao e precisa ser reposto antes de gravar [gap: schools_contact_address] |
| ID | ignore |  |  |  |  |  | staging_helper |

### TBL_BANCO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: Uma linha com credencial de API. Nada entra na carga canonica; a chave deve ser revogada na origem.
- Colunas: 5 (map=0, ignore=4, defer=1, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | ignore |  |  |  |  |  | denormalized_display_name |
| ID | ignore |  |  |  |  |  | legacy_audit_only |
| BANCO_DESCRICAO | defer |  |  |  |  |  | bank_registry_not_modeled |
| BANCO_APIKEY | ignore |  |  |  |  |  | credencial comprometida: revogar na origem |
| BANCO_TESTE | ignore |  |  |  |  |  | legacy_flag |

### TBL_CATEGORIAFILHODRE

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 25 linhas do plano de contas do DRE (nivel filho, coluna TBL_CATEGORIAFILHODRE_DESCRICAO). Classificacao usada pelo extrato e pelo DRE; fora do dominio de recebiveis desta fase.
- Colunas: 17 (map=0, ignore=0, defer=17, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FileSystemObjectType | defer |  |  |  |  |  | dre_not_modeled |
| Id | defer |  |  |  |  |  | dre_not_modeled |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | dre_not_modeled |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | dre_not_modeled |
| ID.1 | defer |  |  |  |  |  | dre_not_modeled |
| ContentTypeId | defer |  |  |  |  |  | dre_not_modeled |
| Title | defer |  |  |  |  |  | dre_not_modeled |
| Modified | defer |  |  |  |  |  | dre_not_modeled |
| Created | defer |  |  |  |  |  | dre_not_modeled |
| AuthorId | defer |  |  |  |  |  | dre_not_modeled |
| EditorId | defer |  |  |  |  |  | dre_not_modeled |
| OData__UIVersionString | defer |  |  |  |  |  | dre_not_modeled |
| Attachments | defer |  |  |  |  |  | dre_not_modeled |
| GUID | defer |  |  |  |  |  | dre_not_modeled |
| ComplianceAssetId | defer |  |  |  |  |  | dre_not_modeled |
| TBL_CATEGORIAFILHODRE_DESCRICAO | defer |  |  |  |  |  | dre_not_modeled |
| OData__ColorTag | defer |  |  |  |  |  | dre_not_modeled |

### TBL_CATEGORIAPAGAMENTO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 315 categorias de pagamento (descricao, tipo, item de DRE, categoria pai/filha e linha do DRE). Classificacao de extrato e DRE gerencial.
- Colunas: 22 (map=0, ignore=0, defer=22, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FileSystemObjectType | defer |  |  |  |  |  | dre_not_modeled |
| Id | defer |  |  |  |  |  | dre_not_modeled |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | dre_not_modeled |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | dre_not_modeled |
| ID.1 | defer |  |  |  |  |  | dre_not_modeled |
| ContentTypeId | defer |  |  |  |  |  | dre_not_modeled |
| Title | defer |  |  |  |  |  | dre_not_modeled |
| Modified | defer |  |  |  |  |  | dre_not_modeled |
| Created | defer |  |  |  |  |  | dre_not_modeled |
| AuthorId | defer |  |  |  |  |  | dre_not_modeled |
| EditorId | defer |  |  |  |  |  | dre_not_modeled |
| OData__UIVersionString | defer |  |  |  |  |  | dre_not_modeled |
| Attachments | defer |  |  |  |  |  | dre_not_modeled |
| GUID | defer |  |  |  |  |  | dre_not_modeled |
| ComplianceAssetId | defer |  |  |  |  |  | dre_not_modeled |
| CATEGORIAPAGAMENTO_DESCRICAO | defer |  |  |  |  |  | dre_not_modeled |
| CATEGORIAPAGAMENTO_TIPO | defer |  |  |  |  |  | dre_not_modeled |
| CATEGORIAPAGAMENTO_ITEMDRE_ID | defer |  |  |  |  |  | dre_not_modeled |
| CATEGORIAPRODUTO_CATEGORIAPAIDRE | defer |  |  |  |  |  | dre_not_modeled |
| CATEGORIAPAGAMENTO_CATEGORIAFILH | defer |  |  |  |  |  | dre_not_modeled |
| OData__ColorTag | defer |  |  |  |  |  | dre_not_modeled |
| CATEGORIAPAGAMENTO_LINHADRE | defer |  |  |  |  |  | dre_not_modeled |

### TBL_CATEGORIAPAIDRE

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 8 linhas do nivel pai do plano de contas do DRE.
- Colunas: 17 (map=0, ignore=0, defer=17, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FileSystemObjectType | defer |  |  |  |  |  | dre_not_modeled |
| Id | defer |  |  |  |  |  | dre_not_modeled |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | dre_not_modeled |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | dre_not_modeled |
| ID.1 | defer |  |  |  |  |  | dre_not_modeled |
| ContentTypeId | defer |  |  |  |  |  | dre_not_modeled |
| Title | defer |  |  |  |  |  | dre_not_modeled |
| Modified | defer |  |  |  |  |  | dre_not_modeled |
| Created | defer |  |  |  |  |  | dre_not_modeled |
| AuthorId | defer |  |  |  |  |  | dre_not_modeled |
| EditorId | defer |  |  |  |  |  | dre_not_modeled |
| OData__UIVersionString | defer |  |  |  |  |  | dre_not_modeled |
| Attachments | defer |  |  |  |  |  | dre_not_modeled |
| GUID | defer |  |  |  |  |  | dre_not_modeled |
| ComplianceAssetId | defer |  |  |  |  |  | dre_not_modeled |
| CATEGORIAPAIDRE_DESCRICAO | defer |  |  |  |  |  | dre_not_modeled |
| OData__ColorTag | defer |  |  |  |  |  | dre_not_modeled |

### TBL_CATEGORIAPRODUTO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: Aba com o nome exato da tabela esta vazia (nenhum cabecalho, nenhuma linha). O conteudo esta em TBL_CATEGORIAPRODUTO_FINANCEIRO; a app le CATEGORIAPRODUTO_DESCRICAO em Screen_CadProduto.
- Colunas: 0 (map=0, ignore=0, defer=0, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|

### TBL_CATEGORIAPRODUTO_FINANCEIRO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: Aba irma de TBL_CATEGORIAPRODUTO: 2 categorias de produto, exportadas com as colunas tecnicas do SharePoint ao lado de CATEGORIAPRODUTO_DESCRICAO. Catalogo de produto nao esta modelado nesta fase.
- Colunas: 17 (map=0, ignore=0, defer=17, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FileSystemObjectType | defer |  |  |  |  |  | no_canonical_destination |
| Id | defer |  |  |  |  |  | no_canonical_destination |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | no_canonical_destination |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | no_canonical_destination |
| ID2 | defer |  |  |  |  |  | no_canonical_destination |
| ContentTypeId | defer |  |  |  |  |  | no_canonical_destination |
| Title | defer |  |  |  |  |  | no_canonical_destination |
| Modified | defer |  |  |  |  |  | no_canonical_destination |
| Created | defer |  |  |  |  |  | no_canonical_destination |
| AuthorId | defer |  |  |  |  |  | no_canonical_destination |
| EditorId | defer |  |  |  |  |  | no_canonical_destination |
| OData__UIVersionString | defer |  |  |  |  |  | no_canonical_destination |
| Attachments | defer |  |  |  |  |  | no_canonical_destination |
| GUID | defer |  |  |  |  |  | no_canonical_destination |
| ComplianceAssetId | defer |  |  |  |  |  | no_canonical_destination |
| CATEGORIAPRODUTO_DESCRICAO | defer |  |  |  |  |  | no_canonical_destination |
| OData__ColorTag | defer |  |  |  |  |  | no_canonical_destination |

### TBL_CENTRODECUSTO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 108 centros de custo do financeiro de contas a pagar.
- Colunas: 7 (map=0, ignore=0, defer=7, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | payables_not_modeled |
| CENTRODECUSTO_EMPRESA_ID | defer |  |  |  |  |  | payables_not_modeled |
| CENTRODECUSTO_DESCRICAO | defer |  |  |  |  |  | payables_not_modeled |
| ID | defer |  |  |  |  |  | payables_not_modeled |
| Created | defer |  |  |  |  |  | payables_not_modeled |
| Created By | defer |  |  |  |  |  | payables_not_modeled |
| CENTRODECUSTO_BLOQUEAR | defer |  |  |  |  |  | payables_not_modeled |

### TBL_CLIENTE

- Entidade canonica: customers
- Tipo de linha: entity
- Observacoes: 24.696 clientes. Nome nunca e chave: 19.780 valores distintos para 24.696 linhas. Documento mistura CPF e CNPJ e exige fila de duplicidade na carga.
- Colunas: 18 (map=3, ignore=1, defer=14, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | ignore |  |  |  |  |  | denormalized_display_name |
| ID | map | customers.legacy_id | legacy_id | trim | sim |  |  |
| CLIENTE_NOME | map | customers.full_name | name | collapse_ws | sim |  |  |
| CLIENTE_NOMESOCIAL | defer |  |  |  |  |  | no_canonical_destination |
| CLIENTE_ENDERECO | defer |  |  |  |  |  | address_not_modeled [gap: customers_address] |
| CLIENTE_CNPJ | map | customers.document_number | document | digits |  |  | 2.138 preenchidos; CPF e CNPJ no mesmo campo [gap: customers_document_type] |
| CLIENTE_CNAECODE | defer |  |  |  |  |  | business_segment_not_modeled |
| CLIENTE_CNAEDESCRICAO | defer |  |  |  |  |  | business_segment_not_modeled |
| CLIENTE_ENDERECONUMERO | defer |  |  |  |  |  | address_not_modeled [gap: customers_address] |
| CLIENTE_COMPLEMENTO | defer |  |  |  |  |  | address_not_modeled [gap: customers_address] |
| CLIENTE_BAIRRO | defer |  |  |  |  |  | address_not_modeled [gap: customers_address] |
| CLIENTE_CIDADE | defer |  |  |  |  |  | address_not_modeled [gap: customers_address] |
| CLIENTE_UF | defer |  |  |  |  |  | address_not_modeled [gap: customers_address] |
| CLIENTE_CEP | defer |  |  |  |  |  | address_not_modeled [gap: customers_address] |
| CLIENTE_STATUS | defer |  |  |  |  |  | 12 rotulos de funil comercial, nao status de cadastro |
| CLIENTE_ORIGEM | defer |  |  |  |  |  | crm_funnel_not_modeled |
| CLIENTE_RESPONSAVEL | defer |  |  |  |  |  | user_link_requires_review |
| CLIENTE_INEP | defer |  |  |  |  |  | codigo INEP de escola (8 digitos, ex. 25020846) repetido por linha de cliente: 12.171 distintos e 12.259 vazios; schools nao tem coluna INEP |

### TBL_CLIENTECONTATO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 1.511 registros de contato comercial com cliente (forma, data, usuario). E historico, nao cadastro de contato.
- Colunas: 9 (map=0, ignore=0, defer=9, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | contact_log_not_modeled |
| CLIENTECONTATO_CLIENTE_ID | defer |  |  |  |  |  | contact_log_not_modeled |
| CLIENTECONTATO_FORMACONTATO | defer |  |  |  |  |  | contact_log_not_modeled |
| CLIENTECONTATO_ENDERECOCONTATO | defer |  |  |  |  |  | contact_log_not_modeled |
| CLIENTECONTATO_OBSERVACAO | defer |  |  |  |  |  | contact_log_not_modeled |
| CLIENTECONTATO_DATA | defer |  |  |  |  |  | contact_log_not_modeled |
| CLIENTECONTATO_STATUSCLIENTE | defer |  |  |  |  |  | contact_log_not_modeled |
| CLIENTECONTATO_USUARIOCONTATO | defer |  |  |  |  |  | contact_log_not_modeled |
| ID | defer |  |  |  |  |  | contact_log_not_modeled |

### TBL_CLIENTEENDTEL

- Entidade canonica: contacts
- Tipo de linha: child
- Observacoes: 54.782 telefones/e-mails de cliente: unica aba que cabe em contacts sem tabela nova. Status `confirmed` (operador, 25/09): customer_id resolvido pelo legacy_id do cliente.
- Colunas: 5 (map=4, ignore=1, defer=0, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | ignore |  |  |  |  |  | denormalized_display_name |
| CLIENTEENDTEL_CLIENTE_ID | map | contacts.customer_id | reference | trim | sim | customers | 54.777 preenchidos; a FK canonica e o UUID do cliente resolvido |
| CLIENTEENDTEL_TIPO | map | contacts.type | code | value_map_ci |  |  | 2 valores distintos; confirmar rotulos na carga [valores: telefone->phone, email->email] |
| CLIENTEENDTEL_VALOR | map | contacts.value | text | trim | sim |  | 54.345 preenchidos; 37.809 distintos |
| ID | map | contacts.legacy_id | legacy_id | trim | sim |  | 54.782 ids distintos; a migration 0009 criou as colunas legacy_* e scripts/backfill_legacy_provenance.py carimba os 46.829 contatos ja carregados antes de a carga passar a usar a chave legada |

### TBL_CLIFOR

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 3.612 clientes/fornecedores do modulo de contas a pagar.
- Colunas: 5 (map=0, ignore=0, defer=5, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | payables_not_modeled |
| CLIFOR_NOME | defer |  |  |  |  |  | payables_not_modeled |
| CLIFOR_TIPO | defer |  |  |  |  |  | payables_not_modeled |
| ID | defer |  |  |  |  |  | payables_not_modeled |
| Created | defer |  |  |  |  |  | payables_not_modeled |

### TBL_CONSULTA_CONTATO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 2.583 consultas de contato com payload JSON por aluno; log operacional, nao dado mestre.
- Colunas: 5 (map=0, ignore=0, defer=5, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | contact_log_not_modeled |
| CONSULTA_CONTATO_ALUNO_ID | defer |  |  |  |  |  | contact_log_not_modeled |
| CONSULTA_CONTATO_USER | defer |  |  |  |  |  | contact_log_not_modeled |
| CONSULTA_CONTATO_JSON | defer |  |  |  |  |  | contact_log_not_modeled |
| ID | defer |  |  |  |  |  | contact_log_not_modeled |

### TBL_CONTA

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 47 contas bancarias internas com saldo.
- Colunas: 9 (map=0, ignore=0, defer=9, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | payables_not_modeled |
| ID | defer |  |  |  |  |  | payables_not_modeled |
| CONTA_DESCRICAO | defer |  |  |  |  |  | payables_not_modeled |
| CONTA_EMPRESA_ID | defer |  |  |  |  |  | payables_not_modeled |
| CONTA_DIARIA | defer |  |  |  |  |  | payables_not_modeled |
| CONTA_SALDOATUAL | defer |  |  |  |  |  | payables_not_modeled |
| Modified | defer |  |  |  |  |  | payables_not_modeled |
| CONTA_SALDO_MENOS90 | defer |  |  |  |  |  | payables_not_modeled |
| Created | defer |  |  |  |  |  | payables_not_modeled |

### TBL_CONTATO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 155.452 registros de historico de contato do aluno. Exige tabela de interacoes; nao cabe em contacts (que e de cliente).
- Colunas: 13 (map=0, ignore=0, defer=13, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | contact_log_not_modeled [gap: students_contact] |
| ID | defer |  |  |  |  |  | contact_log_not_modeled [gap: students_contact] |
| Contato.Aluno.ID | defer |  |  |  |  |  | contact_log_not_modeled [gap: students_contact] |
| Contato.Data | defer |  |  |  |  |  | contact_log_not_modeled [gap: students_contact] |
| Contato.Hora | defer |  |  |  |  |  | contact_log_not_modeled [gap: students_contact] |
| Contato.Tipo | defer |  |  |  |  |  | contact_log_not_modeled [gap: students_contact] |
| Contato.Obs | defer |  |  |  |  |  | contact_log_not_modeled [gap: students_contact] |
| Contato_DataValor | defer |  |  |  |  |  | contact_log_not_modeled [gap: students_contact] |
| Contato.StatusTelefone | defer |  |  |  |  |  | contact_log_not_modeled [gap: students_contact] |
| Contato.Telefone | defer |  |  |  |  |  | contact_log_not_modeled [gap: students_contact] |
| Contato.Usuario | defer |  |  |  |  |  | contact_log_not_modeled [gap: students_contact] |
| Modified | defer |  |  |  |  |  | contact_log_not_modeled [gap: students_contact] |
| Created | defer |  |  |  |  |  | contact_log_not_modeled [gap: students_contact] |

### TBL_DESPESA

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 2.853 despesas de processo/divida (custas).
- Colunas: 10 (map=0, ignore=0, defer=10, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | payables_not_modeled |
| DESPESA_DIVIDA_ID | defer |  |  |  |  |  | payables_not_modeled |
| DESPESA_PROCESSO_ID | defer |  |  |  |  |  | payables_not_modeled |
| DESPESA_DESCRICAO | defer |  |  |  |  |  | payables_not_modeled |
| DESPESA_OBSERVACAO | defer |  |  |  |  |  | payables_not_modeled |
| DESPESA_VALOR | defer |  |  |  |  |  | payables_not_modeled |
| DESPESA_DATA | defer |  |  |  |  |  | payables_not_modeled |
| ID | defer |  |  |  |  |  | payables_not_modeled |
| Created By | defer |  |  |  |  |  | payables_not_modeled |
| Modified By | defer |  |  |  |  |  | payables_not_modeled |

### TBL_DIVIDA

- Entidade canonica: agreements
- Tipo de linha: entity-or-defer
- Observacoes: 6.868 dividas. Decisao do operador (25/09, registrada em 2026-10-22): agreements.legacy_id vem de TBL_PAGAMENTO, entao as colunas desta aba ficam em `defer: no_canonical_destination` e a aba continua fora do canonico (inadimplencia nao esta modelada). Reabrir exige as entidades debts/debt_items.
- Colunas: 10 (map=0, ignore=3, defer=7, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | ignore |  |  |  |  |  | denormalized_display_name |
| ID | defer |  |  |  |  |  | 6.868 ids distintos: a aba fica fora do canonico porque agreements.legacy_id vem de TBL_PAGAMENTO (decisao 2026-09-25) [gap: agreements_source_resolution] |
| Divida.Aluno.ID | defer |  |  |  |  |  | 6.856 preenchidos; viraria agreements.student_id se a divida fosse o acordo, mas o acordo desta fase vem de TBL_PAGAMENTO [gap: agreements_source_resolution] |
| Divida_Nome | defer |  |  |  |  |  | 818 valores distintos; rotulo da divida, viraria agreements.reference se a divida virasse acordo [gap: agreements_source_resolution] |
| Divida.Pagamento.ID | defer |  |  |  |  |  | 1.595 vinculos divida -> acordo/pagamento; a ponte fica preservada no payload de staging [gap: agreements_source_resolution] |
| Divida.ValorOriginalTotal | defer |  |  |  |  |  | somente 47 de 6.868 preenchidos: o total teria de ser derivado dos itens da divida [gap: agreements_source_resolution] |
| Divida.ValorAtualizadoTotal | defer |  |  |  |  |  | valor corrigido: exige indice de correcao (INPC), que nao esta modelado nesta fase [gap: agreements_source_resolution] |
| Divida.Processo.ID | defer |  |  |  |  |  | legal_process_not_modeled |
| Divida_MinData | ignore |  |  |  |  |  | computed_cache |
| Created | ignore |  |  |  |  |  | legacy_audit_only |

### TBL_DIVIDA_LISTAGEM

- Entidade canonica: agreements
- Tipo de linha: child-or-defer
- Observacoes: 42.886 itens de divida. Decisao do operador (25/09, registrada em 2026-10-22): agreements vem de TBL_PAGAMENTO, entao esta aba fica em staging como composicao da divida e as colunas ficam em `defer: no_canonical_destination`. O id do item deixou de exigir `installments.legacy_id`, porque a parcela canonica vem de TBL_PAGAMENTO_LISTAGEM.
- Colunas: 11 (map=0, ignore=4, defer=7, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | ignore |  |  |  |  |  | denormalized_display_name |
| ID | defer |  |  |  |  |  | 42.886 ids distintos: com a aba fora do canonico o id do item nao precisa de coluna em installments (as parcelas vem de TBL_PAGAMENTO_LISTAGEM) [gap: agreements_source_resolution] |
| Divida_Listagem.Divida.ID | defer |  |  |  |  |  | 6.838 dividas distintas; viraria installments.agreement_id se a divida virasse acordo [gap: agreements_source_resolution] |
| Modified | ignore |  |  |  |  |  | legacy_audit_only |
| Divida_Listagem.Vencimento | defer |  |  |  |  |  | 42.886 preenchidos; viraria installments.due_date se a divida virasse acordo [gap: agreements_source_resolution] |
| Divida_Listagem.Valor | defer |  |  |  |  |  | viraria installments.original_amount se a divida virasse acordo [gap: agreements_source_resolution] |
| Divida_Listagem.Valor_Atualizado | defer |  |  |  |  |  | valor corrigido: exige regra de juros/INPC, que nao esta modelada nesta fase [gap: agreements_source_resolution] |
| Divida_Listagem.Tipo_de_debito | defer |  |  |  |  |  | 1.074 valores distintos, com lixo (0, [PIUYTREW): installments nao tem tipo/descricao do debito [gap: installments_description] |
| Divida_Listagem.Obs | defer |  |  |  |  |  | no_canonical_destination [gap: installments_description] |
| DividaListagem_DataVencValor | ignore |  |  |  |  |  | computed_cache |
| Created | ignore |  |  |  |  |  | legacy_audit_only |

### TBL_DREAUX

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 366 linhas de apoio do DRE (categoria, classificacao, demonstrativo, subcategoria, linha e empresa).
- Colunas: 22 (map=0, ignore=0, defer=22, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FileSystemObjectType | defer |  |  |  |  |  | dre_not_modeled |
| Id | defer |  |  |  |  |  | dre_not_modeled |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | dre_not_modeled |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | dre_not_modeled |
| ContentTypeId | defer |  |  |  |  |  | dre_not_modeled |
| Title | defer |  |  |  |  |  | dre_not_modeled |
| OData__ColorTag | defer |  |  |  |  |  | dre_not_modeled |
| ComplianceAssetId | defer |  |  |  |  |  | dre_not_modeled |
| DREAUX_CATEGORIA | defer |  |  |  |  |  | dre_not_modeled |
| DREAUX_CLASSIFICACAO | defer |  |  |  |  |  | dre_not_modeled |
| DREAUX_DRE | defer |  |  |  |  |  | dre_not_modeled |
| DREAUX_SUBCATEGORIA | defer |  |  |  |  |  | dre_not_modeled |
| DREAUX_LINHA | defer |  |  |  |  |  | dre_not_modeled |
| DREAUX_EMPRESA_ID | defer |  |  |  |  |  | dre_not_modeled |
| ID.1 | defer |  |  |  |  |  | dre_not_modeled |
| Modified | defer |  |  |  |  |  | dre_not_modeled |
| Created | defer |  |  |  |  |  | dre_not_modeled |
| AuthorId | defer |  |  |  |  |  | dre_not_modeled |
| EditorId | defer |  |  |  |  |  | dre_not_modeled |
| OData__UIVersionString | defer |  |  |  |  |  | dre_not_modeled |
| Attachments | defer |  |  |  |  |  | dre_not_modeled |
| GUID | defer |  |  |  |  |  | dre_not_modeled |

### TBL_DREBASE

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 80 linhas de estrutura/plano do DRE (modelo, item, categoria, grupo e subgrupo).
- Colunas: 21 (map=0, ignore=0, defer=21, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FileSystemObjectType | defer |  |  |  |  |  | dre_not_modeled |
| Id | defer |  |  |  |  |  | dre_not_modeled |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | dre_not_modeled |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | dre_not_modeled |
| ContentTypeId | defer |  |  |  |  |  | dre_not_modeled |
| Title | defer |  |  |  |  |  | dre_not_modeled |
| OData__ColorTag | defer |  |  |  |  |  | dre_not_modeled |
| ComplianceAssetId | defer |  |  |  |  |  | dre_not_modeled |
| DREBASE_MODELO | defer |  |  |  |  |  | dre_not_modeled |
| DREBASE_ITEM | defer |  |  |  |  |  | dre_not_modeled |
| DREBASE_CATEGORIA | defer |  |  |  |  |  | dre_not_modeled |
| DREBASE_GRUPO | defer |  |  |  |  |  | dre_not_modeled |
| DREBASE_SUBGRUPO | defer |  |  |  |  |  | dre_not_modeled |
| ID.1 | defer |  |  |  |  |  | dre_not_modeled |
| Modified | defer |  |  |  |  |  | dre_not_modeled |
| Created | defer |  |  |  |  |  | dre_not_modeled |
| AuthorId | defer |  |  |  |  |  | dre_not_modeled |
| EditorId | defer |  |  |  |  |  | dre_not_modeled |
| OData__UIVersionString | defer |  |  |  |  |  | dre_not_modeled |
| Attachments | defer |  |  |  |  |  | dre_not_modeled |
| GUID | defer |  |  |  |  |  | dre_not_modeled |

### TBL_DREVALOR

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 3.095 valores de DRE por empresa/ano/mes e item (budget x realizado).
- Colunas: 26 (map=0, ignore=0, defer=26, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FileSystemObjectType | defer |  |  |  |  |  | dre_not_modeled |
| Id | defer |  |  |  |  |  | dre_not_modeled |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | dre_not_modeled |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | dre_not_modeled |
| ContentTypeId | defer |  |  |  |  |  | dre_not_modeled |
| Title | defer |  |  |  |  |  | dre_not_modeled |
| OData__ColorTag | defer |  |  |  |  |  | dre_not_modeled |
| ComplianceAssetId | defer |  |  |  |  |  | dre_not_modeled |
| DREVALOR_EMPRESA_ID | defer |  |  |  |  |  | dre_not_modeled |
| DREVALOR_ANO | defer |  |  |  |  |  | dre_not_modeled |
| DREVALOR_MODELO | defer |  |  |  |  |  | dre_not_modeled |
| DREVALOR_CATEGORIA | defer |  |  |  |  |  | dre_not_modeled |
| DREVALOR_GRUPO | defer |  |  |  |  |  | dre_not_modeled |
| DREVALOR_SUBGRUPO | defer |  |  |  |  |  | dre_not_modeled |
| DREVALOR_ITEM | defer |  |  |  |  |  | dre_not_modeled |
| DREVALOR_BUDGET | defer |  |  |  |  |  | dre_not_modeled |
| DREVALOR_REALIZADO | defer |  |  |  |  |  | dre_not_modeled |
| DREVALOR_MES | defer |  |  |  |  |  | dre_not_modeled |
| Modified | defer |  |  |  |  |  | dre_not_modeled |
| ID.1 | defer |  |  |  |  |  | dre_not_modeled |
| Created | defer |  |  |  |  |  | dre_not_modeled |
| AuthorId | defer |  |  |  |  |  | dre_not_modeled |
| EditorId | defer |  |  |  |  |  | dre_not_modeled |
| OData__UIVersionString | defer |  |  |  |  |  | dre_not_modeled |
| Attachments | defer |  |  |  |  |  | dre_not_modeled |
| GUID | defer |  |  |  |  |  | dre_not_modeled |

### TBL_EMAILCOBRANCA

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 148 modelos de e-mail de cobranca por colegio.
- Colunas: 7 (map=0, ignore=0, defer=7, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | billing_email_templates_not_modeled |
| EMAILCOBRANCA_COLEGIO | defer |  |  |  |  |  | billing_email_templates_not_modeled |
| EMAILCOBRANCA_DATA | defer |  |  |  |  |  | billing_email_templates_not_modeled |
| EMAILCOBRANCA_EMAIL | defer |  |  |  |  |  | billing_email_templates_not_modeled |
| EMAILCOBRANCA_USUARIO | defer |  |  |  |  |  | billing_email_templates_not_modeled |
| Attachments | defer |  |  |  |  |  | billing_email_templates_not_modeled |
| ID | defer |  |  |  |  |  | billing_email_templates_not_modeled |

### TBL_EMAILLISTACONTATO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: empty
- Observacoes: Aba sem registros (0 linhas de dados).
- Colunas: 6 (map=0, ignore=6, defer=0, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | ignore |  |  |  |  |  | empty_column |
| Aluno_Nome | ignore |  |  |  |  |  | empty_column |
| Escola_Nome | ignore |  |  |  |  |  | empty_column |
| Data_Ultimo_Contato | ignore |  |  |  |  |  | empty_column |
| Dias_Ate_Hoje | ignore |  |  |  |  |  | empty_column |
| ID | ignore |  |  |  |  |  | empty_column |

### TBL_EMPRESA

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 15 empresas do grupo (razao social, CNPJ, contato, coordenadas).
- Colunas: 13 (map=0, ignore=0, defer=13, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | company_registry_not_modeled |
| ID | defer |  |  |  |  |  | company_registry_not_modeled |
| EMPRESA_NOME | defer |  |  |  |  |  | company_registry_not_modeled |
| EMPRESA_NUMERO | defer |  |  |  |  |  | company_registry_not_modeled |
| EMPRESA_LOTUS | defer |  |  |  |  |  | company_registry_not_modeled |
| EMPRESA_ENDERECO | defer |  |  |  |  |  | company_registry_not_modeled |
| EMPRESA_CEP | defer |  |  |  |  |  | company_registry_not_modeled |
| EMPRESA_CNPJ | defer |  |  |  |  |  | company_registry_not_modeled |
| EMPRESA_TELEFONE | defer |  |  |  |  |  | company_registry_not_modeled |
| EMPRESA_EMAIL | defer |  |  |  |  |  | company_registry_not_modeled |
| EMPRESA_RAZAOSOCIAL | defer |  |  |  |  |  | company_registry_not_modeled |
| EMPRESA_LATITUDE | defer |  |  |  |  |  | company_registry_not_modeled |
| EMPRESA_LONGITUDE | defer |  |  |  |  |  | company_registry_not_modeled |

### TBL_ENDTEL

- Entidade canonica: student_contacts
- Tipo de linha: entity
- Observacoes: 47.562 telefones/e-mails/enderecos de aluno (6.894 alunos, 44.764 linhas com aluno resolvido por students.legacy_id). Entra em student_contacts (0010 + status na 0011), confirmado pelo operador em 2026-10-27: 41.117 linhas tem tipo e valor e sao as carregaveis; 457 tem tipo com valor vazio e 5.988 estao vazias nas duas colunas, entao nao ha o que gravar nelas.
- Colunas: 9 (map=6, ignore=2, defer=1, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | ignore |  |  |  |  |  | denormalized_display_name |
| ENDTEL_ALUNO_ID | map | student_contacts.student_id | reference | trim | sim | students | 44.764 das 47.562 linhas resolvem por students.legacy_id; as demais apontam para aluno fora da carga e a linha e descartada com LOAD_REFERENCE_UNRESOLVED |
| ENDTEL_TIPO | map | student_contacts.type | code | value_map_ci | sim |  | 23.015 TELEFONE, 9.927 ENDERECO, 8.632 EMAIL; as 5.988 sem tipo tambem nao tem valor nem status (nada a carregar), por isso nao ha rotulo sintetico. O rotulo e confiavel em 99,4% das 41.117 linhas com valor: 252 tem `@` e nao estao como EMAIL, 13 EMAIL nao tem `@`, 5 TELEFONE tem letra e 1 TELEFONE tem virgula [valores: telefone->phone, endereco->address, email->email] |
| ENDTEL_STATUS | map | student_contacts.status | code | value_map_ci |  |  | 35.578 ATIVADO, 5.996 DESATIVADO (toda linha com valor tem status); coluna criada pela 0011 [valores: ativado->active, desativado->inactive] |
| ENDTEL_VALOR | map | student_contacts.value | text | collapse_ws | sim |  | 34.042 valores distintos; 6.445 linhas da aba estao sem valor e por isso nao entram (413 delas chegam a este campo e as demais sao descartadas antes, por tipo vazio ou aluno nao resolvido) |
| ENDTEL_PRINCIPAL | map | student_contacts.is_primary | boolean | boolean_sim_nao |  |  | 6.971 SIM, 39.478 NAO, 1.113 vazios (DEFAULT false da 0010) |
| ENDTEL_OBSERVACAO | defer |  |  |  |  |  | no_canonical_destination [gap: students_contact] |
| ENDTEL_ORIGEM | ignore |  |  |  |  |  | legacy_flag |
| ID | map | student_contacts.legacy_id | legacy_id | trim | sim |  |  |

### TBL_ESCOLA

- Entidade canonica: schools
- Tipo de linha: entity
- Observacoes: 75 escolas. legal_name vem de Escola.Nome com sobreposicao de Escola_RazaoSocial; CNPJ normalizado em document_number (6 linhas sem CNPJ).
- Colunas: 16 (map=5, ignore=5, defer=6, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | ignore |  |  |  |  |  | denormalized_display_name |
| ID | map | schools.legacy_id | legacy_id | trim | sim |  |  |
| Escola.Nome | map | schools.legal_name | name | collapse_ws | sim |  |  |
| Escola_DataContrato | defer |  |  |  |  |  | school_config_not_modeled |
| Created | ignore |  |  |  |  |  | legacy_audit_only |
| Modified | ignore |  |  |  |  |  | legacy_audit_only |
| Escola.CNPJ | map | schools.document_number | document | digits |  |  | 69 preenchidos; unicidade forte avaliada na carga |
| Escola.Endereco | defer |  |  |  |  |  | no_canonical_destination [gap: schools_contact_address] |
| Escola.Telefone | defer |  |  |  |  |  | no_canonical_destination [gap: schools_contact_address] |
| EscolaLogo | ignore |  |  |  |  |  | empty_column |
| Escola.TipoAcordo | defer |  |  |  |  |  | school_config_not_modeled |
| Escola_NomeFantasia | map | schools.trade_name | name | collapse_ws |  |  |  |
| Escola_Email | defer |  |  |  |  |  | contact_destination_requires_customer_link [gap: schools_contact_address] |
| Escola_DadosBancarios | ignore |  |  |  |  |  | empty_column |
| Escola_ComoConheceu | defer |  |  |  |  |  | school_config_not_modeled |
| Escola_RazaoSocial | map | schools.legal_name | name | collapse_ws |  |  | sobrepoe Escola.Nome quando preenchido (38 linhas) |

### TBL_EXTRATO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: Aba com o nome exato da tabela esta vazia (nenhum cabecalho, nenhuma linha). Os 29 campos de TBL_EXTRATO usados pela app estao em TBL_EXTRATO_FINANCEIRO.
- Colunas: 0 (map=0, ignore=0, defer=0, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|

### TBL_EXTRATOOLD_FINANCEIRO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 64.451 lancamentos da tabela antiga TBL_EXTRATOOLD, que nao tem aba com o proprio nome. Cobre os 16 campos que a app le nessa tabela em Screen_CadExtrato_Old; historico a conciliar com TBL_EXTRATO antes de qualquer carga.
- Colunas: 44 (map=0, ignore=0, defer=44, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FileSystemObjectType | defer |  |  |  |  |  | billing_integration_not_modeled |
| Id | defer |  |  |  |  |  | billing_integration_not_modeled |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | billing_integration_not_modeled |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | billing_integration_not_modeled |
| ID2 | defer |  |  |  |  |  | billing_integration_not_modeled |
| ContentTypeId | defer |  |  |  |  |  | billing_integration_not_modeled |
| Title | defer |  |  |  |  |  | billing_integration_not_modeled |
| Modified | defer |  |  |  |  |  | billing_integration_not_modeled |
| Created | defer |  |  |  |  |  | billing_integration_not_modeled |
| AuthorId | defer |  |  |  |  |  | billing_integration_not_modeled |
| EditorId | defer |  |  |  |  |  | billing_integration_not_modeled |
| OData__UIVersionString | defer |  |  |  |  |  | billing_integration_not_modeled |
| Attachments | defer |  |  |  |  |  | billing_integration_not_modeled |
| GUID | defer |  |  |  |  |  | billing_integration_not_modeled |
| ComplianceAssetId | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_DATA | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_DATA_PAGREC | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_DATA_VENC | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_LANCAMENTO | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_VALOR | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_VALORPAGO | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_CONTA_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_CDC_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_CATEGORIAPAGAMENTO_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_PAGAMENTO_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_CLIFOR_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_EMPRESA_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_TIPOLANCAMENTO | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_STATUS | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_OBSERVACAO | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_VENDA_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_NUMEROPARCELA | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_TIPONOTINHA | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_PAGAMENTO_LISTAGEM_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_EDITAVEL | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_RESPONSAVEL | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_COLEGIO | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_ALUNO | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_ESCOLA_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_ALUNO_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_EXTRATO_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| OData__ColorTag | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_DATACOMPETENCIA | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATOOLD_SUBITEM | defer |  |  |  |  |  | billing_integration_not_modeled |

### TBL_EXTRATO_FINANCEIRO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 39.944 lancamentos de extrato e unica origem dos 29 campos de TBL_EXTRATO lidos pela app (Screen_CadExtrato, Screen_Financeiro, aprovacao). Export com as colunas tecnicas do SharePoint antes das colunas de negocio.
- Colunas: 46 (map=0, ignore=0, defer=46, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FI | defer |  |  |  |  |  | billing_integration_not_modeled |
| Id | defer |  |  |  |  |  | billing_integration_not_modeled |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | billing_integration_not_modeled |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | billing_integration_not_modeled |
| ID2 | defer |  |  |  |  |  | billing_integration_not_modeled |
| ContentTypeId | defer |  |  |  |  |  | billing_integration_not_modeled |
| Title | defer |  |  |  |  |  | billing_integration_not_modeled |
| Modified | defer |  |  |  |  |  | billing_integration_not_modeled |
| Created | defer |  |  |  |  |  | billing_integration_not_modeled |
| AuthorId | defer |  |  |  |  |  | billing_integration_not_modeled |
| EditorId | defer |  |  |  |  |  | billing_integration_not_modeled |
| OData__UIVersionString | defer |  |  |  |  |  | billing_integration_not_modeled |
| Attachments | defer |  |  |  |  |  | billing_integration_not_modeled |
| GUID | defer |  |  |  |  |  | billing_integration_not_modeled |
| ComplianceAssetId | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_DATA | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_LANCAMENTO | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_VALOR | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_CONTA_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_CDC_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_CATEGORIA_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_CLIFOR_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_DATA_PAGREC | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_DATA_VENC | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_EMPRESA_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_TIPOLANCAMENTO | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_VALORPAGO | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_STATUS | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_OBSERVACAO | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_PAGAMENTO_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_VENDA_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_NUMEROPARCELA | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_TIPONOTINHA | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_PAGAMENTO_LISTAGEM_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_EDITAVEL | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_RESPONSAVEL | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_COLEGIO | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_ALUNO | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_ESCOLA_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_ALUNO_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_CHAVEAUX_APROVACAOPEDIDO | defer |  |  |  |  |  | billing_integration_not_modeled |
| OData__ColorTag | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_DATACOMPETENCIA | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_SUBITEM | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_GRUPO | defer |  |  |  |  |  | billing_integration_not_modeled |
| EXTRATO_DRECATEGORIA | defer |  |  |  |  |  | billing_integration_not_modeled |

### TBL_FABRICANTE

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 4 fabricantes de produto usados em Screen_CadProduto.
- Colunas: 17 (map=0, ignore=0, defer=17, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FileSystemObjectType | defer |  |  |  |  |  | no_canonical_destination |
| Id | defer |  |  |  |  |  | no_canonical_destination |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | no_canonical_destination |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | no_canonical_destination |
| ID.1 | defer |  |  |  |  |  | no_canonical_destination |
| ContentTypeId | defer |  |  |  |  |  | no_canonical_destination |
| Title | defer |  |  |  |  |  | no_canonical_destination |
| Modified | defer |  |  |  |  |  | no_canonical_destination |
| Created | defer |  |  |  |  |  | no_canonical_destination |
| AuthorId | defer |  |  |  |  |  | no_canonical_destination |
| EditorId | defer |  |  |  |  |  | no_canonical_destination |
| OData__UIVersionString | defer |  |  |  |  |  | no_canonical_destination |
| Attachments | defer |  |  |  |  |  | no_canonical_destination |
| GUID | defer |  |  |  |  |  | no_canonical_destination |
| ComplianceAssetId | defer |  |  |  |  |  | no_canonical_destination |
| FABRICANTE_NOME | defer |  |  |  |  |  | no_canonical_destination |
| OData__ColorTag | defer |  |  |  |  |  | no_canonical_destination |

### TBL_FERIADO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 9 datas de feriado usadas no calculo de vencimentos.
- Colunas: 5 (map=0, ignore=0, defer=5, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | calendar_not_modeled |
| FERIADO_DATA | defer |  |  |  |  |  | calendar_not_modeled |
| FERIADO_TESTE1 | defer |  |  |  |  |  | calendar_not_modeled |
| FERIADO_TESTE2 | defer |  |  |  |  |  | calendar_not_modeled |
| ID | defer |  |  |  |  |  | calendar_not_modeled |

### TBL_FLUXOCAIXA

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 13.016 linhas de fluxo de caixa (conta, data, valor e chave data+conta).
- Colunas: 20 (map=0, ignore=0, defer=20, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FileSystemObjectType | defer |  |  |  |  |  | billing_integration_not_modeled |
| Id | defer |  |  |  |  |  | billing_integration_not_modeled |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | billing_integration_not_modeled |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | billing_integration_not_modeled |
| ID.1 | defer |  |  |  |  |  | billing_integration_not_modeled |
| ContentTypeId | defer |  |  |  |  |  | billing_integration_not_modeled |
| Title | defer |  |  |  |  |  | billing_integration_not_modeled |
| Modified | defer |  |  |  |  |  | billing_integration_not_modeled |
| Created | defer |  |  |  |  |  | billing_integration_not_modeled |
| AuthorId | defer |  |  |  |  |  | billing_integration_not_modeled |
| EditorId | defer |  |  |  |  |  | billing_integration_not_modeled |
| OData__UIVersionString | defer |  |  |  |  |  | billing_integration_not_modeled |
| Attachments | defer |  |  |  |  |  | billing_integration_not_modeled |
| GUID | defer |  |  |  |  |  | billing_integration_not_modeled |
| ComplianceAssetId | defer |  |  |  |  |  | billing_integration_not_modeled |
| FLUXOCAIXA_CONTA_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| FLUXOCAIXA_DATA | defer |  |  |  |  |  | billing_integration_not_modeled |
| FLUXOCAIXA_VALOR | defer |  |  |  |  |  | billing_integration_not_modeled |
| FLUXOCAIXA_CHAVEDATACONTA | defer |  |  |  |  |  | billing_integration_not_modeled |
| OData__ColorTag | defer |  |  |  |  |  | billing_integration_not_modeled |

### TBL_FORNECEDOR

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 3 fornecedores de contas a pagar. A planilha traz FORNECEDOR_NOME e uma coluna tecnica extra (ID2).
- Colunas: 17 (map=0, ignore=0, defer=17, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FileSystemObjectType | defer |  |  |  |  |  | payables_not_modeled |
| Id | defer |  |  |  |  |  | payables_not_modeled |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | payables_not_modeled |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | payables_not_modeled |
| ID2 | defer |  |  |  |  |  | payables_not_modeled |
| ContentTypeId | defer |  |  |  |  |  | payables_not_modeled |
| Title | defer |  |  |  |  |  | payables_not_modeled |
| Modified | defer |  |  |  |  |  | payables_not_modeled |
| Created | defer |  |  |  |  |  | payables_not_modeled |
| AuthorId | defer |  |  |  |  |  | payables_not_modeled |
| EditorId | defer |  |  |  |  |  | payables_not_modeled |
| OData__UIVersionString | defer |  |  |  |  |  | payables_not_modeled |
| Attachments | defer |  |  |  |  |  | payables_not_modeled |
| GUID | defer |  |  |  |  |  | payables_not_modeled |
| ComplianceAssetId | defer |  |  |  |  |  | payables_not_modeled |
| FORNECEDOR_NOME | defer |  |  |  |  |  | payables_not_modeled |
| OData__ColorTag | defer |  |  |  |  |  | payables_not_modeled |

### TBL_GUIACUSTAS

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 20 linhas de custas judiciais (descricao e valor).
- Colunas: 4 (map=0, ignore=0, defer=4, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | legal_fees_table_not_modeled |
| GUIACUSTAS_DESCRICAO | defer |  |  |  |  |  | legal_fees_table_not_modeled |
| GUIA_CUSTAS_VALOR | defer |  |  |  |  |  | legal_fees_table_not_modeled |
| ID | defer |  |  |  |  |  | legal_fees_table_not_modeled |

### TBL_HISTORICO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 156 linhas de historico de alteracoes (tipo, mudanca e data) sem entidade alvo; auditoria canonica nova e independente.
- Colunas: 19 (map=0, ignore=0, defer=19, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FileSystemObjectType | defer |  |  |  |  |  | no_canonical_destination |
| Id | defer |  |  |  |  |  | no_canonical_destination |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | no_canonical_destination |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | no_canonical_destination |
| ID.1 | defer |  |  |  |  |  | no_canonical_destination |
| ContentTypeId | defer |  |  |  |  |  | no_canonical_destination |
| Title | defer |  |  |  |  |  | no_canonical_destination |
| Modified | defer |  |  |  |  |  | no_canonical_destination |
| Created | defer |  |  |  |  |  | no_canonical_destination |
| AuthorId | defer |  |  |  |  |  | no_canonical_destination |
| EditorId | defer |  |  |  |  |  | no_canonical_destination |
| OData__UIVersionString | defer |  |  |  |  |  | no_canonical_destination |
| Attachments | defer |  |  |  |  |  | no_canonical_destination |
| GUID | defer |  |  |  |  |  | no_canonical_destination |
| ComplianceAssetId | defer |  |  |  |  |  | no_canonical_destination |
| HISTORICO_TIPO | defer |  |  |  |  |  | no_canonical_destination |
| HISTORICO_MUDANCA | defer |  |  |  |  |  | no_canonical_destination |
| HISTORICO_DATA | defer |  |  |  |  |  | no_canonical_destination |
| OData__ColorTag | defer |  |  |  |  |  | no_canonical_destination |

### TBL_HORAATUALIZADO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: Uma linha de controle com o horario da ultima atualizacao dos relatorios e do fluxo de caixa.
- Colunas: 20 (map=0, ignore=0, defer=20, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FileSystemObjectType | defer |  |  |  |  |  | no_canonical_destination |
| Id | defer |  |  |  |  |  | no_canonical_destination |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | no_canonical_destination |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | no_canonical_destination |
| ContentTypeId | defer |  |  |  |  |  | no_canonical_destination |
| Title | defer |  |  |  |  |  | no_canonical_destination |
| ComplianceAssetId | defer |  |  |  |  |  | no_canonical_destination |
| HORAATUALIZADO_RELATORIO | defer |  |  |  |  |  | no_canonical_destination |
| HORAATUALIZADO_DATA | defer |  |  |  |  |  | no_canonical_destination |
| HORAATUALIZADO_ATUALIZANDO | defer |  |  |  |  |  | no_canonical_destination |
| HORAATUALIZADO_DATAFLUXO | defer |  |  |  |  |  | no_canonical_destination |
| OData__ColorTag | defer |  |  |  |  |  | no_canonical_destination |
| ID.1 | defer |  |  |  |  |  | no_canonical_destination |
| Modified | defer |  |  |  |  |  | no_canonical_destination |
| Created | defer |  |  |  |  |  | no_canonical_destination |
| AuthorId | defer |  |  |  |  |  | no_canonical_destination |
| EditorId | defer |  |  |  |  |  | no_canonical_destination |
| OData__UIVersionString | defer |  |  |  |  |  | no_canonical_destination |
| Attachments | defer |  |  |  |  |  | no_canonical_destination |
| GUID | defer |  |  |  |  |  | no_canonical_destination |

### TBL_INPC

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 194 indices INPC por data. Necessario ao recalculo de dividas corrigidas.
- Colunas: 4 (map=0, ignore=0, defer=4, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | inflation_index_not_modeled |
| INPC.Data | defer |  |  |  |  |  | inflation_index_not_modeled |
| INPC.Valor | defer |  |  |  |  |  | inflation_index_not_modeled |
| ID | defer |  |  |  |  |  | inflation_index_not_modeled |

### TBL_ITEMDRE

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 15 linhas do DRE (descricao, selecionavel e ordem) usadas para montar o demonstrativo.
- Colunas: 19 (map=0, ignore=0, defer=19, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FileSystemObjectType | defer |  |  |  |  |  | dre_not_modeled |
| Id | defer |  |  |  |  |  | dre_not_modeled |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | dre_not_modeled |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | dre_not_modeled |
| ID.1 | defer |  |  |  |  |  | dre_not_modeled |
| ContentTypeId | defer |  |  |  |  |  | dre_not_modeled |
| Title | defer |  |  |  |  |  | dre_not_modeled |
| Modified | defer |  |  |  |  |  | dre_not_modeled |
| Created | defer |  |  |  |  |  | dre_not_modeled |
| AuthorId | defer |  |  |  |  |  | dre_not_modeled |
| EditorId | defer |  |  |  |  |  | dre_not_modeled |
| OData__UIVersionString | defer |  |  |  |  |  | dre_not_modeled |
| Attachments | defer |  |  |  |  |  | dre_not_modeled |
| GUID | defer |  |  |  |  |  | dre_not_modeled |
| ComplianceAssetId | defer |  |  |  |  |  | dre_not_modeled |
| ITEMDRE_DESCRICAO | defer |  |  |  |  |  | dre_not_modeled |
| ITEMDRE_SELECIONAVEL | defer |  |  |  |  |  | dre_not_modeled |
| ITEMDRE_ORDEM | defer |  |  |  |  |  | dre_not_modeled |
| OData__ColorTag | defer |  |  |  |  |  | dre_not_modeled |

### TBL_LOGIN

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 78 logins do legado (usuario, senha, nome, tipo, nivel e email). Nenhuma credencial migra: LOGIN_PASS e senha em texto claro e o restante so entraria com email novo e senha redefinida.
- Colunas: 22 (map=0, ignore=1, defer=21, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FileSystemObjectType | defer |  |  |  |  |  | user_import_requires_credential_reset |
| Id | defer |  |  |  |  |  | user_import_requires_credential_reset |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | user_import_requires_credential_reset |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | user_import_requires_credential_reset |
| ID.1 | defer |  |  |  |  |  | user_import_requires_credential_reset |
| ContentTypeId | defer |  |  |  |  |  | user_import_requires_credential_reset |
| Title | defer |  |  |  |  |  | user_import_requires_credential_reset |
| Modified | defer |  |  |  |  |  | user_import_requires_credential_reset |
| Created | defer |  |  |  |  |  | user_import_requires_credential_reset |
| AuthorId | defer |  |  |  |  |  | user_import_requires_credential_reset |
| EditorId | defer |  |  |  |  |  | user_import_requires_credential_reset |
| OData__UIVersionString | defer |  |  |  |  |  | user_import_requires_credential_reset |
| Attachments | defer |  |  |  |  |  | user_import_requires_credential_reset |
| GUID | defer |  |  |  |  |  | user_import_requires_credential_reset |
| ComplianceAssetId | defer |  |  |  |  |  | user_import_requires_credential_reset |
| LOGIN_USER | defer |  |  |  |  |  | user_import_requires_credential_reset |
| LOGIN_PASS | ignore |  |  |  |  |  | senha do legado em texto claro; revogar na origem |
| LOGIN_NOME | defer |  |  |  |  |  | user_import_requires_credential_reset |
| LOGIN_TIPO | defer |  |  |  |  |  | user_import_requires_credential_reset |
| LOGIN_NIVEL | defer |  |  |  |  |  | user_import_requires_credential_reset |
| OData__ColorTag | defer |  |  |  |  |  | user_import_requires_credential_reset |
| LOGIN_EMAIL | defer |  |  |  |  |  | user_import_requires_credential_reset |

### TBL_MODELODOC

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: Um modelo de documento em HTML.
- Colunas: 5 (map=0, ignore=0, defer=5, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | document_templates_not_modeled |
| ID | defer |  |  |  |  |  | document_templates_not_modeled |
| MODELODOC_DESCRICAO | defer |  |  |  |  |  | document_templates_not_modeled |
| MODELODOC_HTML | defer |  |  |  |  |  | document_templates_not_modeled |
| MODELODOC_TENTATIVA | defer |  |  |  |  |  | document_templates_not_modeled |

### TBL_MODELODOCHISTORICO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 1.296 geracoes de documento a partir do modelo.
- Colunas: 4 (map=0, ignore=0, defer=4, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | document_templates_not_modeled |
| MODELODOCHISTORICO_MODELO_ID | defer |  |  |  |  |  | document_templates_not_modeled |
| Created | defer |  |  |  |  |  | document_templates_not_modeled |
| ID | defer |  |  |  |  |  | document_templates_not_modeled |

### TBL_PAGAMENTO

- Entidade canonica: agreements
- Tipo de linha: entity
- Observacoes: 1.572 acordos/pagamentos e a origem confirmada de agreements (fase 7). Decisao do operador (25/09): o cliente pagador nunca existiu como coluna no app legado (TBL_CLIENTE e registro institucional de CNPJ/CNAE/INEP e nenhuma ponte por e-mail/telefone/nome/CNPJ fechou), entao ele e sintetizado desta propria aba - customers.legacy_id = Pagamento.ID, customers.full_name = Pagamento.Nome_Aluno e asaas_customers.external_id = Pagamento.CliAsaas_ID com ambiente `production`. agreements.customer_id entra por `links: row:customers` e total_amount/installments_count sao derivados de TBL_PAGAMENTO_LISTAGEM.
- Colunas: 24 (map=6, ignore=7, defer=10, review=1, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | ignore |  |  |  |  |  | denormalized_display_name |
| ID | map | agreements.legacy_id | legacy_id | trim | sim |  | TBL_PAGAMENTO e a origem do acordo; TBL_DIVIDA fica como composicao em staging |
| Pagamento_CliAsaas_ID | map | asaas_customers.external_id | text | trim | sim |  | 1.122 preenchidos (2 ids repetidos): chave do cliente pagador no Asaas |
| Pagamento.ValorParcelaTotal | ignore |  |  |  |  |  | empty_column |
| Pagamento.ValorPagoTotal | ignore |  |  |  |  |  | empty_column |
| Pagamento.Nome_Aluno | map | customers.full_name | name | collapse_ws | sim |  | rotulo do cliente pagador sintetizado; sem este nome a linha nao cria customers e o acordo fica sem customer_id (LOAD_ROW_LINK_UNRESOLVED) |
| Pagamento.Nome_Escola | ignore |  |  |  |  |  | denormalized_display_name |
| Created | ignore |  |  |  |  |  | legacy_audit_only |
| Pagamento.UsuarioFechamento | defer |  |  |  |  |  | user_link_requires_review |
| Pagamento.Escola_ID | map | agreements.school_id | reference | trim | sim | schools | 1.571 preenchidos, 1 vazio |
| Attachments | ignore |  |  |  |  |  | attachment_metadata |
| Pagamento.Aluno_ID | map | agreements.student_id | reference | trim |  | students | 1.568 preenchidos, 4 vazios; contem listas ('102;103') |
| Pagamento.Tipo | defer |  |  |  |  |  | JUDICIAL, EXTRAJUDICIAL, CEJUSC, PERSONALIZADO [gap: agreements_type] |
| Pagamento_Nome | map | agreements.reference | text | collapse_ws |  |  | rotulo do lote de acordo ('Acordo 2024': 557, 'Acordo 2023': 438, 'Acordo 2025': 186; 73 rotulos em 1.570 linhas). Agrupa lotes, nao identifica acordo - a identidade continua em agreements.legacy_id (TBL_PAGAMENTO.ID); nenhuma outra coluna escrevia em agreements.reference. Confirmado pelo operador em 2026-10-27 depois da validacao em tela, entao a cadeia financeira deixou de exigir --allow-proposed agreements |
| Pagamento_USUARIOCRIACAO | defer |  |  |  |  |  | user_link_requires_review |
| Pagamento_StatusAcordo | ignore |  |  |  |  |  | empty_column |
| Pagamento_DataFechamento | review |  |  |  |  |  | 1.497 de 1.572 preenchidos; agreements.closed_at existe desde a 0010 e a coluna segue em revisao porque nao esta definido se a data e o fechamento do acordo (parcelamento encerrado) ou a assinatura do contrato [gap: agreements_closed_at] |
| Pagamento_SucumbenciaTotal | defer |  |  |  |  |  | agreement_attrs_not_modeled |
| Pagamento_SucumbenciaResto | defer |  |  |  |  |  | agreement_attrs_not_modeled |
| Pagamento_SucumbenciaTipo | defer |  |  |  |  |  | agreement_attrs_not_modeled |
| Pagamento_PorcCobrar | defer |  |  |  |  |  | agreement_attrs_not_modeled |
| Pagamento_EmailPrincipal | defer |  |  |  |  |  | contact_destination_requires_customer_link |
| Pagamento_CelPrincipal | defer |  |  |  |  |  | contact_destination_requires_customer_link |
| Pagamento_Aluno_ID | defer |  |  |  |  |  | coluna duplicada de Pagamento.Aluno_ID; 1.152 preenchidos e nao confiaveis |

### TBL_PAGAMENTO_FINANCEIRO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 23.961 contas a pagar (solicitacao, aprovacao, banco, PIX). Fora do dominio de recebiveis desta fase.
- Colunas: 37 (map=0, ignore=0, defer=37, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_COMPROVANTE | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_TIPO | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_DATAPAGAMENTOSOLICITACAO | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_DATAREALIZADO | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_DATAAGENDAMENTO | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_BANCO | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_EMPRESAPAGAR | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_FORMA | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_CONTAPAGAMENTO | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_AGPAGAMENTO | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_PIX | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_CENTRODECUSTO | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_APLICACAO | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_DOC | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_VALOR | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_STATUS | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_CATEGORIAPAGAMENTO_ID | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_SOLICITANTE | defer |  |  |  |  |  | payables_not_modeled |
| Attachments | defer |  |  |  |  |  | payables_not_modeled |
| ID | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_EXTRATO_ID | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_OBRAREGISTRO | defer |  |  |  |  |  | payables_not_modeled |
| Created | defer |  |  |  |  |  | payables_not_modeled |
| Modified | defer |  |  |  |  |  | payables_not_modeled |
| Created By | defer |  |  |  |  |  | payables_not_modeled |
| Modified By | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_APROVACAOPEDIDO_ID | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_CHAVEAUX_APROVACAO | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_DATACOMPETENCIA | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_FORNECEDOR_ID | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_GRUPO | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_COMITE_ID | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_DRECATEGORIA | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_FINANCEIROBUDGET | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_CONTA_ID | defer |  |  |  |  |  | payables_not_modeled |
| PAGAMENTO_TAG | defer |  |  |  |  |  | payables_not_modeled |

### TBL_PAGAMENTO_LISTAGEM

- Entidade canonica: installments
- Tipo de linha: child
- Observacoes: 15.535 parcelas de acordo. Origem confirmada de installments e payments (status `confirmed`, operador 25/09). 245 duplicidades de (acordo, parcela) e 236 parcelas repetidas dentro do mesmo acordo continuam bloqueando a carga. `links` liga payments/asaas_charges a parcela criada pela mesma linha de origem.
- Colunas: 34 (map=17, ignore=13, defer=4, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | ignore |  |  |  |  |  | denormalized_display_name |
| ID | map | installments.legacy_id | legacy_id | trim | sim |  | 15.535 ids distintos; a migration 0009 criou as colunas legacy_* e scripts/backfill_legacy_provenance.py carimba as 15.259 parcelas ja carregadas antes de a carga passar a usar a chave legada |
| Pagamento_Listagem.Pagamento.ID | map | installments.agreement_id | reference | trim | sim | agreements | 15.529 preenchidos, 6 vazios, 1.508 acordos distintos |
| Pagamento_Lista_ValorSucumbencia | defer |  |  |  |  |  | agreement_attrs_not_modeled |
| Pagamento_Listagem.Valor_Parcela | map | installments.original_amount | numeric | money | sim |  |  |
| Pagamento_Listagem.Valor_Pago | map | payments.amount | numeric | min_positive | sim |  | 13.245 preenchidos; payments so existe quando o valor pago e > 0 (vazio/zero/negativo descarta a linha) |
| Pagamento_Listagem.Data_Pagamento | map | payments.paid_at | datetime | iso_datetime |  |  | 11.983 preenchidos |
| Pagamento_Listagem.Data_Vencimento | map | installments.due_date | date | iso_date | sim |  |  |
| Pagamento_Lista.Status | map | payments.retention_status | code | value_map_ci |  |  | 5 rotulos, todos preenchidos (15.535 linhas): AGUARDANDO APROVACAO 7.524, REPASSE REALIZADO 6.993, NAO EXISTE REPASSE 744, PAGAMENTO DIRETO 176, REPASSE APROVADO 98. Destino criado pela migration 0008 (lacuna payments_retention_approval), com o CHECK de rotulos na coluna [valores: aguardando aprovacao->pending_approval, repasse aprovado->approved, repasse realizado->released, nao existe repasse->not_applicable, pagamento direto->direct_payment] |
| Pagamento_Lista.DataAprovacao | map | payments.retention_approved_at | date | iso_date |  |  | 7.091 preenchidos (2020-11-09 a 2026-03-30); o legado grava datetime ISO (`2024-06-04T00:00:00`) e a normalizacao usa a parte da data |
| Pagamento_Lista.ValorRetido | map | payments.retained_amount | numeric | money |  |  | retencao por parcela: min(valor_pago * percentual, meta da escola) |
| Pagamento_Lista.MesAnoProgramacaoRepasse | map | payments.retention_scheduled_month | text | month_year |  |  | 7.087 preenchidos no formato `MM AAAA` (`09 2024`, 01 2021 a 12 2025); a normalizacao `month_year` entrega `AAAA-MM` como o CHECK de payments.retention_scheduled_month exige |
| Modified | ignore |  |  |  |  |  | legacy_audit_only |
| Created | ignore |  |  |  |  |  | legacy_audit_only |
| Pagamento_Listagem.Parcela_Numero | map | installments.installment_number | integer | positive_integer | sim |  | 15.534 preenchidos; a CHECK do schema exige > 0, entao 0/negativo e lixo e nao vira parcela (nem conta no agregado do acordo); unicidade por (agreement_id, installment_number) |
| Pagamento_Lista.MesAnoRepasseRealizado | map | payments.retention_released_at | date | iso_date |  |  | 6.875 preenchidos (2020-12-07 a 2026-03-06) como datetime ISO: apesar do nome, a coluna guarda a data em que o repasse foi realizado |
| Pagamento_Lista.InicioDivida | ignore |  |  |  |  |  | ano de inicio da divida, derivavel de installments |
| Pagamento_Lista.TipoAcordo | defer |  |  |  |  |  | agreement_attrs_not_modeled [gap: agreements_type] |
| Pagamento_Lista.PorcentagemAcordo | map | payments.retention_percentage | numeric | fraction |  |  | 7.080 preenchidos, 76 valores distintos entre 0 e 0,35: e a fracao de retencao de min(valor_pago * percentual, meta da escola). A normalizacao `fraction` aceita virgula decimal e ruido de float (0,25000001 > 0.2500) e recusa o que sai de 0..1 |
| Pagamento_Lista.PGTColegio | ignore |  |  |  |  |  | 2 valores distintos (flag) |
| Modified By | ignore |  |  |  |  |  | legacy_audit_only |
| Pagamento_Lista_Vazio | ignore |  |  |  |  |  | computed_cache |
| Pagamento_Listagem_Tipo | defer |  |  |  |  |  | Pagamento Padrao em 14.923 linhas e Pagamento Resgate Judicial em 140 (472 vazios): payments nao tem tipo e payments.source guarda a origem tecnica (manual/Asaas), nao o tipo |
| Pagamento_Extrato_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| Pagamento_Categoria | ignore |  |  |  |  |  | empty_column |
| Pagamento_Banco_Status | map | asaas_charges.status | code | value_map_ci | sim |  | 9 valores (15.535 linhas): vazio 4.799, BAIXADO 4.175, PAGO AUTOMATICO 3.250, ATRASADO 1.240, PENDENTE 1.127, PAGO COLEGIO 439, PAGAMENTO MANUAL 353, CARTAO ITAU 151, `z` 1 (lixo). O vazio e o `z` caem no DEFAULT 'unknown' criado pela migration 0008 e saem como LOAD_VALUE_DEFAULTED; CARTAO ITAU entra como paid e o billing_type CREDIT_CARD fica registrado como decisao de operacao em docs/MIGRATION_WORKFLOW.md [valores: baixado->paid, pago automatico->paid, pagamento manual->paid, pago colegio->paid, cartao itau->paid, pendente->pending, atrasado->overdue] |
| Pagamento_PagAsaas_ID | map | asaas_charges.external_id | text | trim |  |  | 6.369 distintos = unico na origem |
| Pagamento_CliAsaas_ID | ignore |  |  |  |  |  | empty_column |
| Pagamento_LinkPag | map | asaas_charges.invoice_url | url | trim |  |  |  |
| Pagamento_CopiaeCola | map | asaas_charges.pix_qr_code | text | trim |  |  |  |
| Pagamento_Whats | ignore |  |  |  |  |  | legacy_flag |
| Pagamento_Email | ignore |  |  |  |  |  | legacy_flag |
| Pagamento_BoletoCriado | ignore |  |  |  |  |  | legacy_flag |
| Pagamento_UltimaDataEnvioAtraso | ignore |  |  |  |  |  | empty_column |

### TBL_PEDIDO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 5.080 pedidos/aprovacoes de compra (solicitante, descricao, valor total, datas, status, desconto, tipo, pagamento direto e categoria). Alimenta Screen_Aprovacaopedido; contas a pagar ficam fora do dominio desta fase.
- Colunas: 29 (map=0, ignore=0, defer=29, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FileSystemObjectType | defer |  |  |  |  |  | payables_not_modeled |
| Id | defer |  |  |  |  |  | payables_not_modeled |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | payables_not_modeled |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | payables_not_modeled |
| ID.1 | defer |  |  |  |  |  | payables_not_modeled |
| ContentTypeId | defer |  |  |  |  |  | payables_not_modeled |
| Title | defer |  |  |  |  |  | payables_not_modeled |
| Modified | defer |  |  |  |  |  | payables_not_modeled |
| Created | defer |  |  |  |  |  | payables_not_modeled |
| AuthorId | defer |  |  |  |  |  | payables_not_modeled |
| EditorId | defer |  |  |  |  |  | payables_not_modeled |
| OData__UIVersionString | defer |  |  |  |  |  | payables_not_modeled |
| Attachments | defer |  |  |  |  |  | payables_not_modeled |
| GUID | defer |  |  |  |  |  | payables_not_modeled |
| ComplianceAssetId | defer |  |  |  |  |  | payables_not_modeled |
| PEDIDO_SOLICITANTE | defer |  |  |  |  |  | payables_not_modeled |
| PEDIDO_DESCRICAO | defer |  |  |  |  |  | payables_not_modeled |
| PEDIDO_VALORTOTAL | defer |  |  |  |  |  | payables_not_modeled |
| PEDIDO_LOGIN_ID | defer |  |  |  |  |  | payables_not_modeled |
| PEDIDO_DATACRIACAO | defer |  |  |  |  |  | payables_not_modeled |
| PEDIDO_DATANECESSIDADE | defer |  |  |  |  |  | payables_not_modeled |
| PEDIDO_STATUS | defer |  |  |  |  |  | payables_not_modeled |
| PEDIDO_DESCONTO | defer |  |  |  |  |  | payables_not_modeled |
| PEDIDO_QTITENS | defer |  |  |  |  |  | payables_not_modeled |
| PEDIDO_TIPOPEDIDO | defer |  |  |  |  |  | payables_not_modeled |
| PEDIDO_PAGAMENTODIRETO | defer |  |  |  |  |  | payables_not_modeled |
| OData__ColorTag | defer |  |  |  |  |  | payables_not_modeled |
| PEDIDO_COLEGIO | defer |  |  |  |  |  | payables_not_modeled |
| PEDIDO_CATEGORIA | defer |  |  |  |  |  | payables_not_modeled |

### TBL_PROCESSO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 909 processos juridicos com escola, numero, status e honorarios.
- Colunas: 25 (map=0, ignore=0, defer=25, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | legal_process_not_modeled |
| ID | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_Responsavel | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_Escola_ID | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_Escola | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_Numero | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_Status | defer |  |  |  |  |  | legal_process_not_modeled |
| Created | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_DataAjuizamento | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_DataCitacao | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_ValorCalculado | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_HonorariosPorc | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_Honorarios | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_MultaPorc | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_Multa | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_DespesaAtualizada | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_ValorFinal | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_Descricao | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_UltimaData | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_TSAD | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_User_ID | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_Vara | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_UF | defer |  |  |  |  |  | legal_process_not_modeled |
| Processo_Cidade | defer |  |  |  |  |  | legal_process_not_modeled |
| Modified | defer |  |  |  |  |  | legal_process_not_modeled |

### TBL_PROCESSODETALHE

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 3.801 etapas/andamentos de processo.
- Colunas: 7 (map=0, ignore=0, defer=7, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | legal_process_not_modeled |
| ProcessoDetalhe_ProcessoID | defer |  |  |  |  |  | legal_process_not_modeled |
| ProcessoDetalhe_NomeEtapa | defer |  |  |  |  |  | legal_process_not_modeled |
| ProcessoDetalhe_Observacao | defer |  |  |  |  |  | legal_process_not_modeled |
| ProcessoDetalhe_Usuario | defer |  |  |  |  |  | legal_process_not_modeled |
| ProcessoDetalhe_Status | defer |  |  |  |  |  | legal_process_not_modeled |
| ID | defer |  |  |  |  |  | legal_process_not_modeled |

### TBL_PROCESSODIVIDA

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 1.198 vinculos entre processo e divida.
- Colunas: 5 (map=0, ignore=0, defer=5, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | legal_process_not_modeled |
| PROCESSODIVIDAS_PROCESSO_ID | defer |  |  |  |  |  | legal_process_not_modeled |
| PROCESSODIVIDAS_DIVIDA_ID | defer |  |  |  |  |  | legal_process_not_modeled |
| ID | defer |  |  |  |  |  | legal_process_not_modeled |
| Created | defer |  |  |  |  |  | legal_process_not_modeled |

### TBL_PROCESSORESPONSAVEL

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 6 vinculos entre processo e usuario responsavel.
- Colunas: 4 (map=0, ignore=0, defer=4, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | legal_process_not_modeled |
| PROCESSORESPONSAVEL_USER_ID | defer |  |  |  |  |  | legal_process_not_modeled |
| PROCESSORESPONSAVEL_PROCESSO | defer |  |  |  |  |  | legal_process_not_modeled |
| ID | defer |  |  |  |  |  | legal_process_not_modeled |

### TBL_PUBLICACAODETALHE

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 3.625 detalhes de publicacao por processo.
- Colunas: 8 (map=0, ignore=0, defer=8, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | legal_process_not_modeled |
| PUBLICACAODETALHE_VALORUNICO | defer |  |  |  |  |  | legal_process_not_modeled |
| PUBLICACAODETALHE_PUBLICACAO_ID | defer |  |  |  |  |  | legal_process_not_modeled |
| PUBLICACAODETALHE_VALOR | defer |  |  |  |  |  | legal_process_not_modeled |
| PUBLICACAODETALHE_PROCESSO | defer |  |  |  |  |  | legal_process_not_modeled |
| PUBLICACAODETALHE_USER_ID | defer |  |  |  |  |  | legal_process_not_modeled |
| PUBLICACAODETALHE_STATUS | defer |  |  |  |  |  | legal_process_not_modeled |
| ID | defer |  |  |  |  |  | legal_process_not_modeled |

### TBL_PUBLICACOES

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 1.274 publicacoes capturadas.
- Colunas: 4 (map=0, ignore=0, defer=4, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | legal_process_not_modeled |
| PUBLICACOES_DATA | defer |  |  |  |  |  | legal_process_not_modeled |
| PUBLICACOES_TEXTO | defer |  |  |  |  |  | legal_process_not_modeled |
| ID | defer |  |  |  |  |  | legal_process_not_modeled |

### TBL_RECALCULO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 5.164 registros de recalculo de divida por usuario/data.
- Colunas: 5 (map=0, ignore=0, defer=5, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | recalculation_log_not_modeled |
| RECALCULO_DATA | defer |  |  |  |  |  | recalculation_log_not_modeled |
| RECALCULO_USER | defer |  |  |  |  |  | recalculation_log_not_modeled |
| RECALCULO_TIPO | defer |  |  |  |  |  | recalculation_log_not_modeled |
| ID | defer |  |  |  |  |  | recalculation_log_not_modeled |

### TBL_ROTA

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 327 linhas de roteirizacao de visitas a colegios.
- Colunas: 11 (map=0, ignore=0, defer=11, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | route_not_modeled |
| ROTA_CLIENTE_ID | defer |  |  |  |  |  | route_not_modeled |
| ROTA_NOMECOLEGIO | defer |  |  |  |  |  | route_not_modeled |
| ROTA_ENDERECO | defer |  |  |  |  |  | route_not_modeled |
| ROTA_CEP | defer |  |  |  |  |  | route_not_modeled |
| ROTA_FONE1 | defer |  |  |  |  |  | route_not_modeled |
| ROTA_FONE2 | defer |  |  |  |  |  | route_not_modeled |
| ROTA_EMAIL | defer |  |  |  |  |  | route_not_modeled |
| ROTA_TIPOENSINO | defer |  |  |  |  |  | route_not_modeled |
| ROTA_DESCRICAO | defer |  |  |  |  |  | route_not_modeled |
| ID | defer |  |  |  |  |  | route_not_modeled |

### TBL_SUBITEMEXTRATO

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 7 subitens de extrato (descricao, lancamento de origem, categoria, valor e valor pago) usados no rateio do lancamento.
- Colunas: 21 (map=0, ignore=0, defer=21, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| FileSystemObjectType | defer |  |  |  |  |  | billing_integration_not_modeled |
| Id | defer |  |  |  |  |  | billing_integration_not_modeled |
| ServerRedirectedEmbedUri | defer |  |  |  |  |  | billing_integration_not_modeled |
| ServerRedirectedEmbedUrl | defer |  |  |  |  |  | billing_integration_not_modeled |
| ContentTypeId | defer |  |  |  |  |  | billing_integration_not_modeled |
| Title | defer |  |  |  |  |  | billing_integration_not_modeled |
| OData__ColorTag | defer |  |  |  |  |  | billing_integration_not_modeled |
| ComplianceAssetId | defer |  |  |  |  |  | billing_integration_not_modeled |
| SUBITEMEXTRATO_DESCRICAO | defer |  |  |  |  |  | billing_integration_not_modeled |
| SUBITEMEXTRATO_EXTRATO_ID | defer |  |  |  |  |  | billing_integration_not_modeled |
| SUBITEMEXTRATO_CATEGORIAPAGAMENT | defer |  |  |  |  |  | billing_integration_not_modeled |
| SUBITEMEXTRATO_VALOR | defer |  |  |  |  |  | billing_integration_not_modeled |
| SUBITEMEXTRATO_VALORPAGO | defer |  |  |  |  |  | billing_integration_not_modeled |
| ID.1 | defer |  |  |  |  |  | billing_integration_not_modeled |
| Modified | defer |  |  |  |  |  | billing_integration_not_modeled |
| Created | defer |  |  |  |  |  | billing_integration_not_modeled |
| AuthorId | defer |  |  |  |  |  | billing_integration_not_modeled |
| EditorId | defer |  |  |  |  |  | billing_integration_not_modeled |
| OData__UIVersionString | defer |  |  |  |  |  | billing_integration_not_modeled |
| Attachments | defer |  |  |  |  |  | billing_integration_not_modeled |
| GUID | defer |  |  |  |  |  | billing_integration_not_modeled |

### TBL_TAXAESCOLA

- Entidade canonica: (sem entidade canonica nesta fase)
- Tipo de linha: deferred
- Observacoes: 1.182 taxas por escola/ano/tipo.
- Colunas: 8 (map=0, ignore=0, defer=8, review=0, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| Title | defer |  |  |  |  |  | school_fee_not_modeled |
| TAXAESCOLA_ESCOLA_ID | defer |  |  |  |  |  | school_fee_not_modeled |
| TAXAESCOLA_ANO | defer |  |  |  |  |  | school_fee_not_modeled |
| TAXAESCOLA_VALOR | defer |  |  |  |  |  | school_fee_not_modeled |
| TAXAESCOLA_TIPO | defer |  |  |  |  |  | school_fee_not_modeled |
| Modified | defer |  |  |  |  |  | school_fee_not_modeled |
| Created | defer |  |  |  |  |  | school_fee_not_modeled |
| ID | defer |  |  |  |  |  | school_fee_not_modeled |

### TBL_USER

- Entidade canonica: users
- Tipo de linha: entity-deferred
- Observacoes: 28 usuarios internos. Nenhuma senha e migrada: USER_SENHA/USER_PASS sao credenciais comprometidas. Entrada canonica exige email novo e redefinicao de senha.
- Colunas: 13 (map=0, ignore=3, defer=9, review=1, unmapped=0)

| Coluna | Decisao | Destino | Tipo | Normalizacao | Obrig. | Ref | Detalhe |
|---|---|---|---|---|---|---|---|
| ID | review |  |  |  |  |  | users.legacy_* existe desde a 0010 (28 ids); a entrada continua bloqueada porque users.password_hash e NOT NULL e a senha do legado nao migra [gap: users_legacy_import] |
| Title | ignore |  |  |  |  |  | denormalized_display_name |
| USER_USUARIO | defer |  |  |  |  |  | 28 logins distintos; base para o email canonico |
| USER_SENHA | ignore |  |  |  |  |  | secret_revoked |
| USER_NOME | defer |  |  |  |  |  | viraria users.display_name |
| USER_EMAIL | defer |  |  |  |  |  | somente 1 preenchido; email precisa ser reconstruido |
| USER_NIVEL | defer |  |  |  |  |  | 3 niveis (2, 4, 5) sem mapa de papel definido |
| USER_PASS | ignore |  |  |  |  |  | secret_revoked |
| USER_RECEBER_ALUNO | defer |  |  |  |  |  | user_import_requires_credential_reset |
| USER_ALUNOS | defer |  |  |  |  |  | user_import_requires_credential_reset |
| USER_STATUS | defer |  |  |  |  |  | ATIVADO, ATIVO, DESATIVADO |
| USER_FINANCERO | defer |  |  |  |  |  | user_import_requires_credential_reset |
| USER_CPF | defer |  |  |  |  |  | user_import_requires_credential_reset |

## Lacunas de schema (migrations necessarias antes da carga)

| Gap | Descricao | Colunas legadas afetadas |
|---|---|---:|
| `installments_legacy_id` | resolvido pela migration 0009 (colunas legacy_* em installments) e por scripts/backfill_legacy_provenance.py, que carimba as parcelas ja gravadas antes de a carga usar a chave legada | 0 |
| `installments_description` | installments nao tem descricao/tipo do debito (Divida_Listagem.Tipo_de_debito, Obs) | 2 |
| `agreements_source_resolution` | resolvido (decisao de 2026-09-25, registrada no dicionario em 2026-10-22): agreements.legacy_id vem de TBL_PAGAMENTO; TBL_DIVIDA e TBL_DIVIDA_LISTAGEM ficam fora do canonico ate existir modelo de inadimplencia (entidade debts/debt_items) | 11 |
| `agreements_type` | agreements nao tem campo de tipo (JUDICIAL/EXTRAJUDICIAL/CEJUSC/PERSONALIZADO) | 2 |
| `agreements_closed_at` | resolvido no schema pela migration 0010 (agreements.closed_at): a coluna existe e continua sem mapeamento porque a semantica do fechamento (acordo encerrado x contrato assinado) segue em revisao | 1 |
| `schools_contact_address` | schools nao tem contato nem endereco; contacts e restrito a customers | 9 |
| `students_contact` | resolvido no schema pelas migrations 0010 (student_contacts, espelho de contacts apontando para students) e 0011 (student_contacts.status) e mapeado desde a 0011: TBL_ENDTEL entra como `proposed` com type/value/is_primary/status, 41.117 das 47.562 linhas carregaveis (457 tem tipo e valor vazio e 5.988 nao tem tipo, valor nem status) | 14 |
| `customers_address` | customers nao tem endereco estruturado | 7 |
| `customers_document_type` | customers nao tem document_type (cpf/cnpj) exigido por CANONICAL_DATA_RULES.md | 1 |
| `contacts_legacy_id` | resolvido pela migration 0009 (colunas legacy_* em contacts) e por scripts/backfill_legacy_provenance.py, que carimba os contatos ja gravados antes de a carga usar a chave legada | 0 |
| `students_guardian_details` | resolvido no schema pela migration 0011 (guardians): RG, profissao e estado civil do responsavel entram em guardians.document_rg/occupation/marital_status como `proposed`, junto com o nome (Aluno.Responsavel_Financeiro) e o CPF (Aluno.CPFResponsavel) | 0 |
| `users_legacy_import` | resolvido no schema pela migration 0010 (users.legacy_source/legacy_table/legacy_id + indice unico): a importacao continua presa a politica de credencial, porque users.password_hash e NOT NULL e a senha do legado nao migra | 1 |

### installments_description

installments nao tem descricao/tipo do debito (Divida_Listagem.Tipo_de_debito, Obs)

Colunas: `TBL_DIVIDA_LISTAGEM.Divida_Listagem.Tipo_de_debito`, `TBL_DIVIDA_LISTAGEM.Divida_Listagem.Obs`.

### agreements_source_resolution

resolvido (decisao de 2026-09-25, registrada no dicionario em 2026-10-22): agreements.legacy_id vem de TBL_PAGAMENTO; TBL_DIVIDA e TBL_DIVIDA_LISTAGEM ficam fora do canonico ate existir modelo de inadimplencia (entidade debts/debt_items)

Colunas: `TBL_DIVIDA.ID`, `TBL_DIVIDA.Divida.Aluno.ID`, `TBL_DIVIDA.Divida_Nome`, `TBL_DIVIDA.Divida.Pagamento.ID`, `TBL_DIVIDA.Divida.ValorOriginalTotal`, `TBL_DIVIDA.Divida.ValorAtualizadoTotal`, `TBL_DIVIDA_LISTAGEM.ID`, `TBL_DIVIDA_LISTAGEM.Divida_Listagem.Divida.ID`, `TBL_DIVIDA_LISTAGEM.Divida_Listagem.Vencimento`, `TBL_DIVIDA_LISTAGEM.Divida_Listagem.Valor`, `TBL_DIVIDA_LISTAGEM.Divida_Listagem.Valor_Atualizado`.

### agreements_type

agreements nao tem campo de tipo (JUDICIAL/EXTRAJUDICIAL/CEJUSC/PERSONALIZADO)

Colunas: `TBL_PAGAMENTO.Pagamento.Tipo`, `TBL_PAGAMENTO_LISTAGEM.Pagamento_Lista.TipoAcordo`.

### agreements_closed_at

resolvido no schema pela migration 0010 (agreements.closed_at): a coluna existe e continua sem mapeamento porque a semantica do fechamento (acordo encerrado x contrato assinado) segue em revisao

Colunas: `TBL_PAGAMENTO.Pagamento_DataFechamento`.

### schools_contact_address

schools nao tem contato nem endereco; contacts e restrito a customers

Colunas: `TBL_AUXSUBIR.Endereco`, `TBL_AUXSUBIR.Numero`, `TBL_AUXSUBIR.Complemento`, `TBL_AUXSUBIR.Bairro`, `TBL_AUXSUBIR.Municipio`, `TBL_AUXSUBIR.CEP`, `TBL_ESCOLA.Escola.Endereco`, `TBL_ESCOLA.Escola.Telefone`, `TBL_ESCOLA.Escola_Email`.

### students_contact

resolvido no schema pelas migrations 0010 (student_contacts, espelho de contacts apontando para students) e 0011 (student_contacts.status) e mapeado desde a 0011: TBL_ENDTEL entra como `proposed` com type/value/is_primary/status, 41.117 das 47.562 linhas carregaveis (457 tem tipo e valor vazio e 5.988 nao tem tipo, valor nem status)

Colunas: `TBL_CONTATO.Title`, `TBL_CONTATO.ID`, `TBL_CONTATO.Contato.Aluno.ID`, `TBL_CONTATO.Contato.Data`, `TBL_CONTATO.Contato.Hora`, `TBL_CONTATO.Contato.Tipo`, `TBL_CONTATO.Contato.Obs`, `TBL_CONTATO.Contato_DataValor`, `TBL_CONTATO.Contato.StatusTelefone`, `TBL_CONTATO.Contato.Telefone`, `TBL_CONTATO.Contato.Usuario`, `TBL_CONTATO.Modified` e mais 2 coluna(s).

### customers_address

customers nao tem endereco estruturado

Colunas: `TBL_CLIENTE.CLIENTE_ENDERECO`, `TBL_CLIENTE.CLIENTE_ENDERECONUMERO`, `TBL_CLIENTE.CLIENTE_COMPLEMENTO`, `TBL_CLIENTE.CLIENTE_BAIRRO`, `TBL_CLIENTE.CLIENTE_CIDADE`, `TBL_CLIENTE.CLIENTE_UF`, `TBL_CLIENTE.CLIENTE_CEP`.

### customers_document_type

customers nao tem document_type (cpf/cnpj) exigido por CANONICAL_DATA_RULES.md

Colunas: `TBL_CLIENTE.CLIENTE_CNPJ`.

### users_legacy_import

resolvido no schema pela migration 0010 (users.legacy_source/legacy_table/legacy_id + indice unico): a importacao continua presa a politica de credencial, porque users.password_hash e NOT NULL e a senha do legado nao migra

Colunas: `TBL_USER.ID`.

## Decisoes de politica pendentes

| Codigo | Motivo | Ocorrencias | Abas | Exemplos |
|---|---|---:|---|---|
| `REVIEW_REQUIRED` | `pending_policy` | 1 | TBL_PAGAMENTO | `TBL_PAGAMENTO.Pagamento_DataFechamento` |
| `REVIEW_REQUIRED` | `user_import_requires_credential_reset` | 1 | TBL_USER | `TBL_USER.ID` |

## Motivos registrados

| Decisao | Motivo | Colunas | Descricao |
|---|---|---:|---|
| defer | `address_not_modeled` | 13 | endereco estruturado ainda nao tem tabela canonica |
| defer | `agreement_attrs_not_modeled` | 7 | atributo de acordo/divida sem coluna canonica (tipo, sucumbencia, percentual, repasse) |
| defer | `bank_registry_not_modeled` | 1 | cadastro de bancos/contas nao esta modelado nesta fase |
| defer | `billing_email_templates_not_modeled` | 7 | modelos de e-mail de cobranca nao estao modelados nesta fase |
| defer | `billing_integration_not_modeled` | 132 | conciliacao bancaria/extrato fica para fase posterior |
| defer | `business_segment_not_modeled` | 2 | segmento/CNAE e dados de mercado nao estao modelados |
| defer | `calendar_not_modeled` | 5 | calendario de feriados nao esta modelado nesta fase |
| defer | `company_registry_not_modeled` | 13 | cadastro de empresas do grupo nao esta modelado nesta fase |
| defer | `contact_destination_requires_customer_link` | 3 | contato exige cliente resolvido antes de gravar em contacts |
| defer | `contact_log_not_modeled` | 27 | historico de contato exige tabela propria (interactions); nao cabe em contacts |
| defer | `crm_funnel_not_modeled` | 2 | funil comercial (status de negociacao, origem do lead) nao esta modelado |
| defer | `document_templates_not_modeled` | 9 | modelos de documento e historico de geracao nao estao modelados |
| defer | `dre_not_modeled` | 144 | plano de contas/DRE gerencial (categorias, itens e valores) nao esta modelado nesta fase |
| defer | `inflation_index_not_modeled` | 4 | indice de correcao monetaria (INPC) e necessario ao recalculo de dividas; fase posterior |
| defer | `legal_fees_table_not_modeled` | 4 | tabela de custas juridicas nao esta modelada nesta fase |
| defer | `legal_process_not_modeled` | 54 | processos juridicos, publicacoes e etapas ficam para fase posterior |
| defer | `no_canonical_destination` | 97 | sem destino canonico nesta fase; o valor permanece no payload de staging |
| defer | `out_of_scope_operations` | 24 | operacao de escritorio (agenda, tarefas) fora do escopo desta fase |
| defer | `payables_not_modeled` | 114 | contas a pagar, fornecedores e despesas nao entram no dominio canonico desta fase |
| defer | `recalculation_log_not_modeled` | 5 | log de recalculo de dividas nao esta modelado nesta fase |
| defer | `route_not_modeled` | 11 | roteirizacao de visitas nao esta modelada nesta fase |
| defer | `school_config_not_modeled` | 4 | configuracao comercial da escola (tipo de acordo, contrato, origem) nao esta modelada |
| defer | `school_fee_not_modeled` | 8 | tabela de taxas por escola/ano nao esta modelada nesta fase |
| defer | `user_import_requires_credential_reset` | 30 | usuario do legado entra com email novo e senha redefinida; nunca importar credencial |
| defer | `user_link_requires_review` | 5 | vinculo com usuario exige conciliacao; nunca por nome isolado |
| ignore | `attachment_metadata` | 2 | referencia de anexo do Dataverse; arquivos nao migram nesta fase |
| ignore | `computed_cache` | 18 | valor derivado/recalculavel a partir das tabelas canonicas |
| ignore | `constant_placeholder` | 4 | valor constante de preenchimento; nao representa dado do dominio |
| ignore | `denormalized_display_name` | 13 | copia do nome para exibicao na origem; o nome canonico vem da chave estrangeira |
| ignore | `empty_column` | 15 | coluna vazia em todas as linhas da origem |
| ignore | `legacy_audit_only` | 11 | auditoria do PowerApps/Dataverse (Created/Modified/By); a auditoria canonica nova e independente |
| ignore | `legacy_flag` | 7 | flag operacional legado sem equivalente canonico |
| ignore | `secret_revoked` | 4 | segredo/credencial: nunca migrar e deve ser revogado na origem |
| ignore | `staging_helper` | 5 | aba auxiliar de carga manual/planilha; nao representa entidade do dominio |
| review | `pending_policy` | 1 | decisao de negocio pendente registrada na fase 2 |
| review | `user_import_requires_credential_reset` | 1 | usuario do legado entra com email novo e senha redefinida; nunca importar credencial |

## Avisos (nao bloqueiam)

| Codigo | Aba/Tabela | Coluna(s) | Detalhe |
|---|---|---|---|
| `MULTIPLE_LEGACY_ID_PROVIDERS` | customers | TBL_CLIENTE.ID, TBL_PAGAMENTO.ID | - |
