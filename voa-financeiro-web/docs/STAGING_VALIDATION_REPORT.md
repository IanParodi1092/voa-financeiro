# Relatorio de validacao do staging

- Gerado em: `2026-09-25T15:08:56.551593+00:00`
- Lote: `5cd769e4-eaaa-49bd-b5ba-7e03947e5e09`
- Fonte: `VOA.xlsx`
- Status do lote apos a validacao: `staging`
- Linhas verificadas: 419700 em 39 abas
- Resultado: 2 bloqueios, 30 erros, 11 avisos
- Nenhuma escola, cliente, aluno, acordo, parcela, pagamento ou cobranca canonica foi criada.

## Totais por aba

| Aba | Origem | Staged | Linhas com violacao | Duplicidades | Bloqueios | Erros | Avisos | Total (source_total) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| TBL_AGENDA | 185 | 185 | 6 | 0 | 0 | 6 | 0 | - |
| TBL_AGENDAENVIO | 8 | 8 | 0 | 0 | 0 | 0 | 0 | - |
| TBL_ALUNO | 6652 | 6652 | 1103 | 465 | 0 | 1103 | 425 | - |
| TBL_AUXSEPARAR | 1 | 1 | 0 | 0 | 0 | 0 | 0 | - |
| TBL_AUXSUBIR | 9553 | 9553 | 0 | 0 | 0 | 0 | 0 | - |
| TBL_BANCO | 1 | 1 | 0 | 0 | 0 | 0 | 0 | - |
| TBL_CENTRODECUSTO | 108 | 108 | 0 | 0 | 0 | 0 | 0 | - |
| TBL_CLIENTE | 24696 | 24696 | 0 | 8 | 0 | 0 | 22565 | - |
| TBL_CLIENTECONTATO | 1511 | 1511 | 33 | 0 | 0 | 33 | 0 | - |
| TBL_CLIENTEENDTEL | 54782 | 54782 | 7677 | 0 | 0 | 7677 | 0 | - |
| TBL_CLIFOR | 3612 | 3612 | 0 | 0 | 0 | 0 | 0 | - |
| TBL_CONSULTA_CONTATO | 2583 | 2583 | 101 | 0 | 0 | 101 | 0 | - |
| TBL_CONTA | 47 | 47 | 0 | 0 | 0 | 0 | 37 | - |
| TBL_CONTATO | 155452 | 155452 | 2068 | 0 | 0 | 2068 | 0 | - |
| TBL_DESPESA | 2853 | 2853 | 8 | 0 | 0 | 8 | 0 | - |
| TBL_DIVIDA | 6868 | 6868 | 51 | 0 | 0 | 51 | 0 | 93309.95 (Divida.ValorOriginalTotal) |
| TBL_DIVIDA_LISTAGEM | 42886 | 42886 | 34 | 245 | 245 | 34 | 0 | 26655785.94087 (Divida_Listagem.Valor) |
| TBL_EMAILCOBRANCA | 148 | 148 | 0 | 0 | 0 | 0 | 0 | - |
| TBL_EMPRESA | 15 | 15 | 0 | 0 | 0 | 0 | 14 | - |
| TBL_ENDTEL | 47562 | 47562 | 2776 | 0 | 0 | 2776 | 0 | - |
| TBL_ESCOLA | 75 | 75 | 1 | 0 | 0 | 1 | 6 | - |
| TBL_FERIADO | 9 | 9 | 0 | 0 | 0 | 0 | 0 | - |
| TBL_GUIACUSTAS | 20 | 20 | 0 | 0 | 0 | 0 | 0 | - |
| TBL_INPC | 194 | 194 | 0 | 0 | 0 | 0 | 0 | - |
| TBL_MODELODOC | 1 | 1 | 0 | 0 | 0 | 0 | 0 | - |
| TBL_MODELODOCHISTORICO | 1296 | 1296 | 0 | 0 | 0 | 0 | 0 | - |
| TBL_PAGAMENTO | 1572 | 1572 | 117 | 0 | 0 | 117 | 0 | - |
| TBL_PAGAMENTO_FINANCEIRO | 23961 | 23961 | 0 | 0 | 0 | 0 | 0 | - |
| TBL_PAGAMENTO_LISTAGEM | 15535 | 15535 | 9 | 236 | 236 | 9 | 0 | 7323552.85 (Pagamento_Listagem.Valor_Parcela) |
| TBL_PROCESSO | 909 | 909 | 4 | 0 | 0 | 4 | 0 | - |
| TBL_PROCESSODETALHE | 3801 | 3801 | 224 | 0 | 0 | 224 | 0 | - |
| TBL_PROCESSODIVIDA | 1198 | 1198 | 172 | 0 | 0 | 172 | 0 | - |
| TBL_PROCESSORESPONSAVEL | 6 | 6 | 1 | 0 | 0 | 1 | 0 | - |
| TBL_PUBLICACAODETALHE | 3625 | 3625 | 294 | 0 | 0 | 294 | 7250 | - |
| TBL_PUBLICACOES | 1274 | 1274 | 0 | 0 | 0 | 0 | 0 | - |
| TBL_RECALCULO | 5164 | 5164 | 0 | 0 | 0 | 0 | 0 | - |
| TBL_ROTA | 327 | 327 | 6 | 0 | 0 | 6 | 0 | - |
| TBL_TAXAESCOLA | 1182 | 1182 | 0 | 0 | 0 | 0 | 0 | 336.00 (TAXAESCOLA_VALOR) |
| TBL_USER | 28 | 28 | 0 | 0 | 0 | 0 | 23 | - |

## Achados

| Severidade | Codigo | Aba | Campo | Ocorrencias | Amostra |
|---|---|---|---|---:|---|
| error | FK_MISSING_REFERENCE | TBL_AGENDA | Agenda_Aluno_ID | 6 | {"row": 21, "legacy_id": "70", "value": "803", "target": "TBL_ALUNO"} |
| error | DOCUMENT_INVALID | TBL_ALUNO | Aluno.CPFResponsavel | 1091 | {"row": 6, "legacy_id": "7417", "value": "7980882733", "digits": 10, "kind": "cpf"} |
| warning | DOCUMENT_MISSING | TBL_ALUNO | Aluno.CPFResponsavel | 1 | {"row": 557, "legacy_id": "6861"} |
| warning | DUPLICATE_DOCUMENT | TBL_ALUNO | Aluno.CPFResponsavel | 424 | {"digits": 11, "prefix": "0991", "count": 2} |
| error | FK_MISSING_REFERENCE | TBL_ALUNO | Aluno.Escola.ID | 2 | {"row": 557, "legacy_id": "6861"} |
| error | REQUIRED_FIELD_EMPTY | TBL_ALUNO | Aluno.Nome | 10 | {"row": 24, "legacy_id": "7399"} |
| warning | DOCUMENT_MISSING | TBL_CLIENTE | CLIENTE_CNPJ | 22558 | {"row": 2140, "legacy_id": "11723"} |
| warning | DUPLICATE_DOCUMENT | TBL_CLIENTE | CLIENTE_CNPJ | 7 | {"digits": 14, "prefix": "5216", "count": 2} |
| error | FK_MISSING_REFERENCE | TBL_CLIENTECONTATO | CLIENTECONTATO_CLIENTE_ID | 33 | {"row": 2, "legacy_id": "539", "value": "11739", "target": "TBL_CLIENTE"} |
| error | FK_MISSING_REFERENCE | TBL_CLIENTEENDTEL | CLIENTEENDTEL_CLIENTE_ID | 7677 | {"row": 36, "legacy_id": "35174", "value": "14508", "target": "TBL_CLIENTE"} |
| error | FK_MISSING_REFERENCE | TBL_CONSULTA_CONTATO | CONSULTA_CONTATO_ALUNO_ID | 101 | {"row": 55, "legacy_id": "939", "value": "1995", "target": "TBL_ALUNO"} |
| warning | AMOUNT_NEGATIVE | TBL_CONTA | CONTA_SALDOATUAL | 24 | {"row": 8, "legacy_id": "7", "value": "-34500"} |
| warning | AMOUNT_NEGATIVE | TBL_CONTA | CONTA_SALDO_MENOS90 | 13 | {"row": 8, "legacy_id": "7", "value": "-34500"} |
| error | FK_MISSING_REFERENCE | TBL_CONTATO | Contato.Aluno.ID | 2068 | {"row": 886, "legacy_id": "133079", "value": "5174", "target": "TBL_ALUNO"} |
| error | FK_MISSING_REFERENCE | TBL_DESPESA | DESPESA_PROCESSO_ID | 8 | {"row": 1759, "legacy_id": "1567", "value": "407", "target": "TBL_PROCESSO"} |
| error | FK_MISSING_REFERENCE | TBL_DIVIDA | Divida.Aluno.ID | 22 | {"row": 869, "legacy_id": "7009", "value": "1624", "target": "TBL_ALUNO"} |
| error | FK_MISSING_REFERENCE | TBL_DIVIDA | Divida.Pagamento.ID | 4 | {"row": 4652, "legacy_id": "5263", "value": "947", "target": "TBL_PAGAMENTO"} |
| error | FK_MISSING_REFERENCE | TBL_DIVIDA | Divida.Processo.ID | 6 | {"row": 5280, "legacy_id": "117", "value": "32", "target": "TBL_PROCESSO"} |
| error | REQUIRED_FIELD_EMPTY | TBL_DIVIDA | Divida_Nome | 19 | {"row": 2661, "legacy_id": "3108"} |
| blocking | DUPLICATE_COMPOSITE_KEY | TBL_DIVIDA_LISTAGEM | Divida_Listagem.Divida.ID + Divida_Listagem.Vencimento + Divida_Listagem.Valor | 245 | {"row": 19, "legacy_id": "22026", "key": ["3419", "2021-10-10T20:00:00", "408"]} |
| error | FK_MISSING_REFERENCE | TBL_DIVIDA_LISTAGEM | Divida_Listagem.Divida.ID | 23 | {"row": 5866, "legacy_id": "3650", "value": "617", "target": "TBL_DIVIDA"} |
| error | REQUIRED_FIELD_EMPTY | TBL_DIVIDA_LISTAGEM | Divida_Listagem.Valor | 11 | {"row": 7663, "legacy_id": "9898"} |
| warning | DOCUMENT_MISSING | TBL_EMPRESA | EMPRESA_CNPJ | 14 | {"row": 2, "legacy_id": "1"} |
| error | FK_MISSING_REFERENCE | TBL_ENDTEL | ENDTEL_ALUNO_ID | 2776 | {"row": 2, "legacy_id": "2630", "value": "625", "target": "TBL_ALUNO"} |
| error | DOCUMENT_INVALID | TBL_ESCOLA | Escola.CNPJ | 1 | {"row": 74, "legacy_id": "84", "value": "123123123123", "digits": 12, "kind": "cnpj"} |
| warning | DOCUMENT_MISSING | TBL_ESCOLA | Escola.CNPJ | 6 | {"row": 16, "legacy_id": "22"} |
| error | FK_MISSING_REFERENCE | TBL_PAGAMENTO | Pagamento.Aluno_ID | 115 | {"row": 25, "legacy_id": "1686", "value": "1152", "target": "TBL_ALUNO"} |
| error | FK_MISSING_REFERENCE | TBL_PAGAMENTO | Pagamento.Escola_ID | 1 | {"row": 236, "legacy_id": "1461"} |
| error | FK_MISSING_REFERENCE | TBL_PAGAMENTO | Pagamento_Aluno_ID | 1 | {"row": 25, "legacy_id": "1686", "value": "1152", "target": "TBL_ALUNO"} |
| blocking | DUPLICATE_COMPOSITE_KEY | TBL_PAGAMENTO_LISTAGEM | Pagamento_Listagem.Pagamento.ID + Pagamento_Listagem.Parcela_Numero | 236 | {"row": 950, "legacy_id": "3844", "key": ["436", "2"]} |
| error | FK_MISSING_REFERENCE | TBL_PAGAMENTO_LISTAGEM | Pagamento_Listagem.Pagamento.ID | 6 | {"row": 13439, "legacy_id": "4953"} |
| error | REQUIRED_FIELD_EMPTY | TBL_PAGAMENTO_LISTAGEM | Pagamento_Listagem.Parcela_Numero | 1 | {"row": 13333, "legacy_id": "65"} |
| error | REQUIRED_FIELD_EMPTY | TBL_PAGAMENTO_LISTAGEM | Pagamento_Listagem.Valor_Parcela | 2 | {"row": 10312, "legacy_id": "8119"} |
| error | FK_MISSING_REFERENCE | TBL_PROCESSO | Processo_User_ID | 4 | {"row": 501, "legacy_id": "30", "value": "19", "target": "TBL_USER"} |
| error | FK_MISSING_REFERENCE | TBL_PROCESSODETALHE | ProcessoDetalhe_ProcessoID | 224 | {"row": 2, "legacy_id": "2317"} |
| error | FK_MISSING_REFERENCE | TBL_PROCESSODIVIDA | PROCESSODIVIDAS_DIVIDA_ID | 13 | {"row": 97, "legacy_id": "205", "value": "1272", "target": "TBL_DIVIDA"} |
| error | FK_MISSING_REFERENCE | TBL_PROCESSODIVIDA | PROCESSODIVIDAS_PROCESSO_ID | 159 | {"row": 68, "legacy_id": "168", "value": "155", "target": "TBL_PROCESSO"} |
| error | FK_MISSING_REFERENCE | TBL_PROCESSORESPONSAVEL | PROCESSORESPONSAVEL_USER_ID | 1 | {"row": 2, "legacy_id": "1", "value": "2", "target": "TBL_USER"} |
| warning | AMOUNT_UNPARSEABLE | TBL_PUBLICACAODETALHE | PUBLICACAODETALHE_VALOR | 3625 | {"row": 2, "legacy_id": "1815", "value": "</tbody></table></td></tr></t..."} |
| warning | AMOUNT_UNPARSEABLE | TBL_PUBLICACAODETALHE | PUBLICACAODETALHE_VALORUNICO | 3625 | {"row": 2, "legacy_id": "1815", "value": "1014919-91.2021.8.26.0405-25/..."} |
| error | FK_MISSING_REFERENCE | TBL_PUBLICACAODETALHE | PUBLICACAODETALHE_USER_ID | 294 | {"row": 3277, "legacy_id": "3246", "value": "19", "target": "TBL_USER"} |
| error | FK_MISSING_REFERENCE | TBL_ROTA | ROTA_CLIENTE_ID | 6 | {"row": 27, "legacy_id": "229", "value": "12094", "target": "TBL_CLIENTE"} |
| warning | DOCUMENT_MISSING | TBL_USER | USER_CPF | 23 | {"row": 2, "legacy_id": "1"} |

## Proximos passos

1. Revisar os bloqueios (`DUPLICATE_COMPOSITE_KEY`) antes de qualquer carga canonica.
2. Decidir caso a caso as referencias ausentes, os CPF/CNPJ invalidos e os documentos duplicados (nunca mesclar automaticamente).
3. Tratar `Aluno.CPFResponsavel` com valores textuais (ex.: `Nao tem CPF: ...`) como campo nao confiavel para identidade, conforme `docs/CANONICAL_DATA_RULES.md`.
4. Nenhum reparo de encoding e necessario: nenhuma assinatura de mojibake foi encontrada no lote. Acentos vistos em logs de terminal sao artefato cp1252/cp850 do console; use `--json-out`/`--report`.
5. Somente depois aprovar o lote e executar a carga canonica com UUIDs novos.
