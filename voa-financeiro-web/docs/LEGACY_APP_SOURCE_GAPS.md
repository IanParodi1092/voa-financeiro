# Lacunas entre o Canvas App legado e as planilhas do workbook

- Gerado em: `2026-09-25T23:48:47.135312+00:00`
- Fonte da app: `_legacy-powerapps/projects-and-sources/_debug/unpack_rollout_fix_20260814`
- Workbook: `_legacy-powerapps/root-exports/VOA.xlsx`
- Solucao Dataverse: `_legacy-powerapps/projects-and-sources/Dataverse/SolutionExport/CDSDefault_unmanaged_unpacked/Entities`
- Data sources da app: 274 (57 tabelas Dataverse, 5 fontes externas)
- Abas do workbook: 60 | Entidades Dataverse: 60 | Campos referenciados pela app: 343
- Script: `scripts/audit_legacy_app_sources.py` (somente leitura).

## Leitura rapida

- 2 tabelas lidas pela app nao tem aba no workbook.
- 3 tabelas tem o conteudo em uma aba irma (ex.: `TBL_EXTRATO` vazio e `TBL_EXTRATO_FINANCEIRO` com os campos).
- 3 abas do workbook nao correspondem a nenhuma entidade da app/Dataverse.
- 2 campos de negocio lidos pela app faltam nas abas correspondentes.
- 4 colunas das abas nao existem no schema atual do Dataverse (nome antigo ou sobra de exportacao).
- 5 fontes externas (Excel Online e conectores) nunca estiveram no workbook.

## 1. Tabelas que a app le e que nao existem no workbook

| Tabela | Entidade Dataverse | Campos no schema | Campos usados pela app | Aba irma (cobertura) | Aba parecida no workbook |
|---|---|---:|---:|---|---|
| TBL_CONSULTA | `cr04f_tbl_consulta` | 5 | 1 | - | TBL_CONTA |
| TBL_EMAILISTACONTATO | `cr04f_tbl_emailistacontato` | 6 | 4 | - | TBL_EMAILLISTACONTATO |

Campos mais usados nessas tabelas ausentes:

- `TBL_CONSULTA`: `CONSULTA_CONTATO_ALUNO_ID` (1)
- `TBL_EMAILISTACONTATO`: `Escola_Nome` (2), `Aluno_Nome` (1), `Data_Ultimo_Contato` (1), `Dias_Ate_Hoje` (1)

## 2. Divergencia de nome entre aba e entidade

| Tabela da app | Aba do workbook |
|---|---|
| TBL_EXTRATOOLD | TBL_EXTRATOOLD_FINANCEIRO |

## 3. Abas do workbook sem entidade correspondente

| Aba | Colunas | Entidade Dataverse | Nome mais proximo na app/Dataverse |
|---|---:|---|---|
| TBL_AUXSUBIR | 12 | - | - |
| TBL_EMAILLISTACONTATO | 6 | - | TBL_EMAILISTACONTATO |
| TBL_PAGAMENTO_FINANCEIRO | 37 | TBL_PAGAMENTO_FINANCEIRO | TBL_PAGAMENTO_FINANCEIRO |

## 3b. Abas irmas que entregam o conteudo da tabela

Quando a aba com o nome exato da tabela esta vazia (ou nao existe) e uma aba com sufixo (`_FINANCEIRO`) tem os mesmos campos, o diagnostico usa a aba irma. A tabela nao esta sem aba: o conteudo dela esta apenas sob outro nome, e o stager/dicionario devem apontar para essa aba.

| Tabela | Aba com o nome da tabela | Aba usada | Campos cobertos |
|---|---|---|---|
| TBL_CATEGORIAPRODUTO | TBL_CATEGORIAPRODUTO | TBL_CATEGORIAPRODUTO_FINANCEIRO | 1/1 |
| TBL_EXTRATO | TBL_EXTRATO | TBL_EXTRATO_FINANCEIRO | 29/29 |
| TBL_EXTRATOOLD | - | TBL_EXTRATOOLD_FINANCEIRO | 16/16 |

## 4. Campos de negocio que a app le e que a aba nao tem

| Tabela | Aba | Campo | Referencias | Telas |
|---|---|---|---:|---|
| TBL_CENTRODECUSTO | TBL_CENTRODECUSTO | `EMPRESA_ID` | 1 | Screen_Financeiro.fx.yaml |
| TBL_CONTA | TBL_CONTA | `CONTA_NOME` | 27 | Screen_CadExtrato.fx.yaml, Screen_CadExtrato_Old.fx.yaml, Screen_Financeiro.fx.yaml |

Campos de moeda base (`* (Base)`, `ExchangeRate`) que a app enxerga e a aba nao tem:

Nenhum.

## 5. Colunas das abas que nao existem no schema atual do Dataverse

| Aba | Colunas |
|---|---|
| TBL_CENTRODECUSTO | `CENTRODECUSTO_EMPRESA_ID` |
| TBL_CONTA | `CONTA_DESCRICAO` |
| TBL_EMPRESA | `EMPRESA_NOME` |
| TBL_EXTRATO_FINANCEIRO | `FI` |

## 6. Fontes fora do Dataverse

| Tipo | Fonte | Detalhe | Campos |
|---|---|---|---|
| ServiceInfo | CriarClienteVOAnoAsaas | `ConnectedWadl` | - |
| ServiceInfo | EnvioEmailVisita | `ConnectedWadl` | - |
| ConnectedDataSourceInfo | ImportarExtrato | `me,b%2521wYFVKhZJWkm7feKW6caulLhfk31Hs-5Lj0QVyPDKKM1sv7sX0sJbS7OVKZBXH9c2,01WTLPETZUJLGI23NXKJDYM6QD2BOLMNIN` | ` Valor `, `Categoria`, `Centro de Custo`, `Cliente/Fornecedor`, `Conta`, `Data Lançamento`, `Data pagamento`, `Descrição`, `Empresa`, `__PowerAppsId__` |
| ServiceInfo | VOAExcluirCliente | `ConnectedWadl` | - |
| ServiceInfo | VoaCriarBoletosManual | `ConnectedWadl` | - |

Metadados da app sem dado de negocio (nao precisam de aba): OptionSetInfo=156, StaticDataSourceInfo=12, ViewInfo=44.

## 7. Leitura e decisoes pendentes

- As secoes 1 e 4 sao o que a app consegue ler e o workbook nao entrega: sem elas a tela legada nao e reproduzivel so com a planilha.
- A secao 5 e o inverso: nome antigo dentro da aba (ex.: `CONTA_DESCRICAO`) escondendo a coluna real (`CONTA_NOME`). Precisa de decisao de mapeamento, nao de nova exportacao.
- A secao 3b mostra onde o dado existe, mas sob outro nome de aba: nao falta exportacao, falta apontar o stager e o dicionario (`scripts/legacy_field_map.json`) para a aba irma.
- A secao 3 lista abas auxiliares (manual/exportacao duplicada) que nao representam entidade.
- Nada aqui conecta no banco nem escreve linha canonica; o script apenas le app, workbook e solucao.

Decisoes sugeridas ao operador:

1. `TBL_CONTA.CONTA_NOME` e `TBL_CENTRODECUSTO.EMPRESA_ID`: confirmar o nome atual no Dataverse e ajustar o dicionario; a coluna antiga da aba (`CONTA_DESCRICAO`, `CENTRODECUSTO_EMPRESA_ID`, `EMPRESA_NOME`) passa a `ignore` com motivo explicito.
2. `TBL_EMAILLISTACONTATO` (aba) x `TBL_EMAILISTACONTATO` (entidade): corrigir o nome da aba ou registrar como aba auxiliar, confirmando na origem por que ela veio vazia.
3. Tabelas da secao 1: hoje restam `TBL_CONSULTA` (um lookup para `TBL_CONSULTA_CONTATO`, que ja tem aba) e `TBL_EMAILISTACONTATO` (contato de cobranca). As demais tabelas que faltavam entraram no workbook em 2026-09-25 e ja estao no dicionario com motivo proprio (`payables_not_modeled`, `billing_integration_not_modeled`, `dre_not_modeled`, `no_canonical_destination`).
4. Fontes externas da secao 6: fora do escopo da planilha; documentar como dependencia de integracao (Asaas, e-mail e planilha de extrato no OneDrive).
5. Abas da secao 3b: decidir entre preencher a aba com o nome da tabela ou declarar a aba irma como origem no stager e no dicionario (hoje as tres estao declaradas como `defer`).
