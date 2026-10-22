# Carga canonica do legado (fase 7)

Gerado por `scripts/load_canonical_batch.py` a partir do dicionario 
`scripts/legacy_field_map.json` e do lote de staging aprovado.

| Metrica | Valor |
|---|---:|
| Modo | dry-run |
| Lote | `4609c071-03c3-47fb-beff-5c3bcad6367e` (VOA.xlsx, status committed) |
| Fonte legada | `powerapps-voa` |
| Staging | `localhost:5434/voa_staging` |
| Canonico | `localhost:5434/voa_staging` |
| Topologia | staging e canonico no mesmo banco |
| Entidades prontas | 8 |
| Entidades bloqueadas | 1 |
| Linhas legadas avaliadas | 121991 |
| Linhas carregadas | 104709 |
| Linhas novas | 0 |
| Linhas reutilizadas (idempotencia) | 104709 |
| Linhas descartadas | 17282 |
| Achados registrados | 21 |
| Escrita canonica nesta rodada | nao |

## Plano por entidade canonica

| Tabela | Situacao | Motivo | Dependencias | Colunas mapeadas | Obrigatorias sem cobertura |
|---|---|---|---|---:|---|
| `agreements` | ready |  | customers, schools, students | 7 | nenhuma |
| `asaas_charges` | blocked | required_columns_uncovered (asaas_customer_id, billing_type, due_date, environment, value) | installments | 5 | asaas_customer_id, billing_type, due_date, environment, value |
| `asaas_customers` | ready |  | customers | 3 | nenhuma |
| `contacts` | ready |  | customers | 4 | nenhuma |
| `customers` | ready |  | - | 3 | nenhuma |
| `installments` | ready |  | agreements | 5 | nenhuma |
| `payments` | ready |  | installments | 9 | nenhuma |
| `schools` | ready |  | - | 4 | nenhuma |
| `students` | ready |  | schools | 4 | nenhuma |

## Colunas derivadas (agregados)

| Tabela | Coluna | Origem | Agrupamento | Operacao | Medida | Chave unica | Status |
|---|---|---|---|---|---|---|---|
| `agreements` | `installments_count` | TBL_PAGAMENTO_LISTAGEM | Pagamento_Listagem.Pagamento.ID | count | Pagamento_Listagem.Valor_Parcela | Pagamento_Listagem.Parcela_Numero=installments.installment_number | confirmed |
| `agreements` | `total_amount` | TBL_PAGAMENTO_LISTAGEM | Pagamento_Listagem.Pagamento.ID | sum | Pagamento_Listagem.Valor_Parcela | Pagamento_Listagem.Parcela_Numero=installments.installment_number | confirmed |

| Aba de origem | Linhas lidas | Linhas usadas | Duplicadas ignoradas | Grupos |
|---|---:|---:|---:|---|
| TBL_PAGAMENTO_LISTAGEM | 15535 | 15259 | 263 | `agreements.installments_count`=1505, `agreements.total_amount`=1505 |

## Abas processadas

| Aba | Situacao | Tabelas | Linhas legadas | Carregadas | Descartadas | Ignoradas por status |
|---|---|---|---:|---:|---:|---:|
| TBL_ESCOLA | carregada | schools | 75 | 75 | 0 | 0 |
| TBL_CLIENTE | carregada | customers | 24696 | 24696 | 0 | 0 |
| TBL_AGENDA | no_mapping | - | 185 | 0 | 0 | 0 |
| TBL_AGENDAENVIO | no_mapping | - | 8 | 0 | 0 | 0 |
| TBL_AUXSEPARAR | no_mapping | - | 1 | 0 | 0 | 0 |
| TBL_AUXSUBIR | no_mapping | - | 9553 | 0 | 0 | 0 |
| TBL_BANCO | no_mapping | - | 1 | 0 | 0 | 0 |
| TBL_CATEGORIAFILHODRE | no_mapping | - | 25 | 0 | 0 | 0 |
| TBL_CATEGORIAPAGAMENTO | no_mapping | - | 315 | 0 | 0 | 0 |
| TBL_CATEGORIAPAIDRE | no_mapping | - | 8 | 0 | 0 | 0 |
| TBL_CATEGORIAPRODUTO | no_mapping | - | 0 | 0 | 0 | 0 |
| TBL_CATEGORIAPRODUTO_FINANCEIRO | no_mapping | - | 2 | 0 | 0 | 0 |
| TBL_CENTRODECUSTO | no_mapping | - | 108 | 0 | 0 | 0 |
| TBL_CLIENTECONTATO | no_mapping | - | 1511 | 0 | 0 | 0 |
| TBL_CLIFOR | no_mapping | - | 3612 | 0 | 0 | 0 |
| TBL_CONSULTA_CONTATO | no_mapping | - | 2583 | 0 | 0 | 0 |
| TBL_CONTA | no_mapping | - | 47 | 0 | 0 | 0 |
| TBL_CONTATO | no_mapping | - | 155452 | 0 | 0 | 0 |
| TBL_DESPESA | no_mapping | - | 2853 | 0 | 0 | 0 |
| TBL_DIVIDA | no_mapping | - | 6868 | 0 | 0 | 0 |
| TBL_DIVIDA_LISTAGEM | no_mapping | - | 42886 | 0 | 0 | 0 |
| TBL_DREAUX | no_mapping | - | 366 | 0 | 0 | 0 |
| TBL_DREBASE | no_mapping | - | 80 | 0 | 0 | 0 |
| TBL_DREVALOR | no_mapping | - | 3095 | 0 | 0 | 0 |
| TBL_EMAILCOBRANCA | no_mapping | - | 148 | 0 | 0 | 0 |
| TBL_EMAILLISTACONTATO | no_mapping | - | 0 | 0 | 0 | 0 |
| TBL_EMPRESA | no_mapping | - | 15 | 0 | 0 | 0 |
| TBL_ENDTEL | no_mapping | - | 47562 | 0 | 0 | 0 |
| TBL_EXTRATO | no_mapping | - | 0 | 0 | 0 | 0 |
| TBL_EXTRATOOLD_FINANCEIRO | no_mapping | - | 64451 | 0 | 0 | 0 |
| TBL_EXTRATO_FINANCEIRO | no_mapping | - | 39944 | 0 | 0 | 0 |
| TBL_FABRICANTE | no_mapping | - | 4 | 0 | 0 | 0 |
| TBL_FERIADO | no_mapping | - | 9 | 0 | 0 | 0 |
| TBL_FLUXOCAIXA | no_mapping | - | 13016 | 0 | 0 | 0 |
| TBL_FORNECEDOR | no_mapping | - | 3 | 0 | 0 | 0 |
| TBL_GUIACUSTAS | no_mapping | - | 20 | 0 | 0 | 0 |
| TBL_HISTORICO | no_mapping | - | 156 | 0 | 0 | 0 |
| TBL_HORAATUALIZADO | no_mapping | - | 1 | 0 | 0 | 0 |
| TBL_INPC | no_mapping | - | 194 | 0 | 0 | 0 |
| TBL_ITEMDRE | no_mapping | - | 15 | 0 | 0 | 0 |
| TBL_LOGIN | no_mapping | - | 78 | 0 | 0 | 0 |
| TBL_MODELODOC | no_mapping | - | 1 | 0 | 0 | 0 |
| TBL_MODELODOCHISTORICO | no_mapping | - | 1296 | 0 | 0 | 0 |
| TBL_PAGAMENTO_FINANCEIRO | no_mapping | - | 23961 | 0 | 0 | 0 |
| TBL_PEDIDO | no_mapping | - | 5080 | 0 | 0 | 0 |
| TBL_PROCESSO | no_mapping | - | 909 | 0 | 0 | 0 |
| TBL_PROCESSODETALHE | no_mapping | - | 3801 | 0 | 0 | 0 |
| TBL_PROCESSODIVIDA | no_mapping | - | 1198 | 0 | 0 | 0 |
| TBL_PROCESSORESPONSAVEL | no_mapping | - | 6 | 0 | 0 | 0 |
| TBL_PUBLICACAODETALHE | no_mapping | - | 3625 | 0 | 0 | 0 |
| TBL_PUBLICACOES | no_mapping | - | 1274 | 0 | 0 | 0 |
| TBL_RECALCULO | no_mapping | - | 5164 | 0 | 0 | 0 |
| TBL_ROTA | no_mapping | - | 327 | 0 | 0 | 0 |
| TBL_SUBITEMEXTRATO | no_mapping | - | 7 | 0 | 0 | 0 |
| TBL_TAXAESCOLA | no_mapping | - | 1182 | 0 | 0 | 0 |
| TBL_USER | no_mapping | - | 28 | 0 | 0 | 0 |
| TBL_ALUNO | carregada | students | 6652 | 6641 | 11 | 0 |
| TBL_PAGAMENTO | carregada | customers, agreements, asaas_customers | 1572 | 1505 | 67 | 0 |
| TBL_CLIENTEENDTEL | carregada | contacts | 54782 | 46829 | 7953 | 0 |
| TBL_PAGAMENTO_LISTAGEM | carregada | installments, payments | 15535 | 15259 | 276 | 0 |

## Resultado por tabela

| Tabela | Legadas | Carregadas | Novas | Reusadas | Atualizadas | Descartadas | Motivos de descarte |
|---|---:|---:|---:|---:|---:|---:|---|
| `agreements` | 1572 | 1505 | 0 | 1505 | 0 | 67 | LOAD_AGGREGATE_MISSING=63, LOAD_ROW_LINK_UNRESOLVED=4 |
| `asaas_customers` | 1572 | 1120 | 0 | 1120 | 0 | 452 | LOAD_DUPLICATE_ROW=2, LOAD_REQUIRED_FIELD_EMPTY=446, LOAD_ROW_LINK_UNRESOLVED=4 |
| `contacts` | 54782 | 46829 | 0 | 46829 | 0 | 7953 | LOAD_REFERENCE_UNRESOLVED=7648, LOAD_REQUIRED_FIELD_EMPTY=305 |
| `customers` | 26268 | 26264 | 0 | 26264 | 0 | 4 | LOAD_REQUIRED_FIELD_EMPTY=4 |
| `installments` | 15535 | 15259 | 0 | 15259 | 0 | 276 | LOAD_DUPLICATE_ROW=263, LOAD_REFERENCE_UNRESOLVED=3, LOAD_REQUIRED_FIELD_EMPTY=10 |
| `payments` | 15535 | 7016 | 0 | 7016 | 0 | 8519 | LOAD_REQUIRED_FIELD_EMPTY=8243, LOAD_ROW_LINK_UNRESOLVED=276 |
| `schools` | 75 | 75 | 0 | 75 | 0 | 0 | - |
| `students` | 6652 | 6641 | 0 | 6641 | 0 | 11 | LOAD_REFERENCE_UNRESOLVED=1, LOAD_REQUIRED_FIELD_EMPTY=10 |

## Totais monetarios por tabela

| Tabela | Coluna | Total no staging |
|---|---|---:|
| `agreements` | `total_amount` | 7161716.00 |
| `installments` | `original_amount` | 7161716.00 |
| `payments` | `amount` | 3594788.37 |
| `payments` | `retained_amount` | 924781.71 |
| `payments` | `retention_percentage` | 1762.3887 |

## Achados

| Aba | Codigo | Campo | Linhas | Exemplos |
|---|---|---|---:|---|
| TBL_ALUNO | `LOAD_REFERENCE_UNRESOLVED` | Aluno.Escola.ID | 1 | linha 6160: students: Aluno.Escola.ID=16 sem registro em schools |
| TBL_ALUNO | `LOAD_REQUIRED_FIELD_EMPTY` | Aluno.Nome | 10 | linha 24: students: Aluno.Nome vazio na origem; linha 557: students: Aluno.Nome vazio na origem; linha 983: students: Aluno.Nome vazio na origem |
| TBL_ALUNO | `LOAD_VALUE_DEFAULTED` | Aluno_Ativo | 114 | linha 6194: students.status vazio na origem; usado padrao canonico 'active'; linha 6197: students.status vazio na origem; usado padrao canonico 'active'; linha 6198: students.status vazio na origem; usado padrao canonico 'active' |
| TBL_CLIENTEENDTEL | `LOAD_REFERENCE_UNRESOLVED` | CLIENTEENDTEL_CLIENTE_ID | 7648 | linha 36: contacts: CLIENTEENDTEL_CLIENTE_ID=14508 sem registro em customers; linha 37: contacts: CLIENTEENDTEL_CLIENTE_ID=14723 sem registro em customers; linha 38: contacts: CLIENTEENDTEL_CLIENTE_ID=14743 sem registro em customers |
| TBL_CLIENTEENDTEL | `LOAD_REQUIRED_FIELD_EMPTY` | CLIENTEENDTEL_CLIENTE_ID | 5 | linha 1435: contacts: CLIENTEENDTEL_CLIENTE_ID vazio na origem; linha 1693: contacts: CLIENTEENDTEL_CLIENTE_ID vazio na origem; linha 11422: contacts: CLIENTEENDTEL_CLIENTE_ID vazio na origem |
| TBL_CLIENTEENDTEL | `LOAD_REQUIRED_FIELD_EMPTY` | CLIENTEENDTEL_VALOR | 300 | linha 2: contacts: CLIENTEENDTEL_VALOR vazio na origem; linha 3: contacts: CLIENTEENDTEL_VALOR vazio na origem; linha 4: contacts: CLIENTEENDTEL_VALOR vazio na origem |
| TBL_PAGAMENTO | `LOAD_AGGREGATE_MISSING` | agreements.total_amount <- TBL_PAGAMENTO_LISTAGEM | 63 | linha 10: agreements: sem agregado de TBL_PAGAMENTO_LISTAGEM (sum de Pagamento_Listagem.Valor_Parcela) para o id legado 1704; linha 25: agreements: sem agregado de TBL_PAGAMENTO_LISTAGEM (sum de Pagamento_Listagem.Valor_Parcela) para o id legado 1686; linha 89: agreements: sem agregado de TBL_PAGAMENTO_LISTAGEM (sum de Pagamento_Listagem.Valor_Parcela) para o id legado 1617 |
| TBL_PAGAMENTO | `LOAD_DUPLICATE_ROW` | external_id | 2 | linha 632: asaas_customers: external_id ja existe no canonico (linha TBL_PAGAMENTO.632); linha 825: asaas_customers: external_id ja existe no canonico (linha TBL_PAGAMENTO.825) |
| TBL_PAGAMENTO | `LOAD_REFERENCE_MULTIVALUE` | Pagamento.Aluno_ID | 110 | linha 26: agreements.student_id recebeu 2 ids: 6661;6662; linha 40: agreements.student_id recebeu 2 ids: 380;379; linha 46: agreements.student_id recebeu 2 ids: 375;374 |
| TBL_PAGAMENTO | `LOAD_REFERENCE_UNRESOLVED` | Pagamento.Aluno_ID | 1 | linha 25: agreements.student_id: students sem correspondente para '1152' |
| TBL_PAGAMENTO | `LOAD_REQUIRED_FIELD_EMPTY` | Pagamento.Nome_Aluno | 4 | linha 236: customers: Pagamento.Nome_Aluno vazio na origem; linha 1480: customers: Pagamento.Nome_Aluno vazio na origem; linha 1482: customers: Pagamento.Nome_Aluno vazio na origem |
| TBL_PAGAMENTO | `LOAD_REQUIRED_FIELD_EMPTY` | Pagamento_CliAsaas_ID | 446 | linha 24: asaas_customers: Pagamento_CliAsaas_ID vazio na origem; linha 25: asaas_customers: Pagamento_CliAsaas_ID vazio na origem; linha 125: asaas_customers: Pagamento_CliAsaas_ID vazio na origem |
| TBL_PAGAMENTO | `LOAD_ROW_LINK_UNRESOLVED` | agreements.customer_id -> customers | 4 | linha 236: agreements: vinculo da propria linha nao resolvido; linha 1480: agreements: vinculo da propria linha nao resolvido; linha 1482: agreements: vinculo da propria linha nao resolvido |
| TBL_PAGAMENTO | `LOAD_ROW_LINK_UNRESOLVED` | asaas_customers.customer_id -> customers | 4 | linha 236: asaas_customers: vinculo da propria linha nao resolvido; linha 1480: asaas_customers: vinculo da propria linha nao resolvido; linha 1482: asaas_customers: vinculo da propria linha nao resolvido |
| TBL_PAGAMENTO_LISTAGEM | `LOAD_DUPLICATE_ROW` | agreement_id+installment_number | 263 | linha 950: installments: agreement_id+installment_number ja existe no canonico (linha legada TBL_PAGAMENTO_LISTAGEM.3844); linha 951: installments: agreement_id+installment_number ja existe no canonico (linha legada TBL_PAGAMENTO_LISTAGEM.3845); linha 952: installments: agreement_id+installment_number ja existe no canonico (linha legada TBL_PAGAMENTO_LISTAGEM.3846) |
| TBL_PAGAMENTO_LISTAGEM | `LOAD_MONTH_YEAR_UNPARSEABLE` | Pagamento_Lista.MesAnoProgramacaoRepasse | 1 | linha 13255: valor legado '10' descartado em payments.retention_scheduled_month |
| TBL_PAGAMENTO_LISTAGEM | `LOAD_REFERENCE_UNRESOLVED` | Pagamento_Listagem.Pagamento.ID | 3 | linha 10312: installments: Pagamento_Listagem.Pagamento.ID=912 sem registro em agreements; linha 10884: installments: Pagamento_Listagem.Pagamento.ID=1704 sem registro em agreements; linha 13333: installments: Pagamento_Listagem.Pagamento.ID=33 sem registro em agreements |
| TBL_PAGAMENTO_LISTAGEM | `LOAD_REQUIRED_FIELD_EMPTY` | Pagamento_Listagem.Pagamento.ID | 6 | linha 13439: installments: Pagamento_Listagem.Pagamento.ID vazio na origem; linha 13440: installments: Pagamento_Listagem.Pagamento.ID vazio na origem; linha 13441: installments: Pagamento_Listagem.Pagamento.ID vazio na origem |
| TBL_PAGAMENTO_LISTAGEM | `LOAD_REQUIRED_FIELD_EMPTY` | Pagamento_Listagem.Parcela_Numero | 4 | linha 11566: installments: Pagamento_Listagem.Parcela_Numero vazio apos normalizacao; linha 13053: installments: Pagamento_Listagem.Parcela_Numero vazio apos normalizacao; linha 13064: installments: Pagamento_Listagem.Parcela_Numero vazio apos normalizacao |
| TBL_PAGAMENTO_LISTAGEM | `LOAD_REQUIRED_FIELD_EMPTY` | Pagamento_Listagem.Valor_Pago | 8243 | linha 2: payments: Pagamento_Listagem.Valor_Pago vazio apos normalizacao; linha 3: payments: Pagamento_Listagem.Valor_Pago vazio apos normalizacao; linha 4: payments: Pagamento_Listagem.Valor_Pago vazio apos normalizacao |
| TBL_PAGAMENTO_LISTAGEM | `LOAD_ROW_LINK_UNRESOLVED` | payments.installment_id -> installments | 276 | linha 950: payments: vinculo da propria linha nao resolvido; linha 951: payments: vinculo da propria linha nao resolvido; linha 952: payments: vinculo da propria linha nao resolvido |

## Contagens canonicas

| Tabela | Antes | Depois |
|---|---:|---:|
| `agreements` | 1505 | 1505 |
| `asaas_charges` | 0 | 0 |
| `asaas_customers` | 1120 | 1120 |
| `contacts` | 46829 | 46829 |
| `customers` | 26264 | 26264 |
| `installments` | 15259 | 15259 |
| `payments` | 7016 | 7016 |
| `schools` | 75 | 75 |
| `students` | 6641 | 6641 |

## Bloqueios e proximos passos

- `asaas_charges`: required_columns_uncovered (asaas_customer_id, billing_type, due_date, environment, value)
