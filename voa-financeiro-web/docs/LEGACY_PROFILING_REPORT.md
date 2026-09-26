# Perfil quantitativo inicial do legado

Fonte: `VOA.xlsx`, lido em modo somente leitura. A contagem inclui a linha de cabecalho conforme a dimensao da planilha; `rows` abaixo representa registros de dados.

## Totais e chaves

| Entidade | Registros | Chave legada | Resultado |
|---|---:|---|---|
| Escolas | 75 | `TBL_ESCOLA.ID` | 75 distintos, sem duplicidade |
| Clientes | 24.696 | `TBL_CLIENTE.ID` | 24.696 distintos, sem duplicidade |
| Alunos | 6.652 | `TBL_ALUNO.ID` | 6.652 distintos, sem duplicidade |
| Acordos/pagamentos | 1.572 | `TBL_PAGAMENTO.ID` | 1.572 distintos, sem duplicidade |
| Itens de parcela | 15.535 | `TBL_PAGAMENTO_LISTAGEM.ID` | 15.535 distintos, sem duplicidade |
| Dividas | 6.868 | `TBL_DIVIDA.ID` | precisa validar no próximo perfil completo |
| Itens de divida | 42.886 | `TBL_DIVIDA_LISTAGEM.ID` | precisa validar no próximo perfil completo |

## Duplicidades e vazios relevantes

### Escolas

- `Escola.Nome`: 75 preenchidos, 75 distintos.
- `Escola.CNPJ`: 69 preenchidos, 69 distintos; 6 vazios.
- Pode haver duplicidade futura por variação de nome, mas a amostra atual nao mostra repeticao normalizada.

### Clientes

- `CLIENTE_NOME`: 24.696 preenchidos, 19.597 distintos.
- 3.976 nomes repetidos, totalizando 5.099 registros alem da primeira ocorrencia.
- `CLIENTE_CNPJ`: somente 2.138 preenchidos; 2.130 distintos.
- 7 documentos repetidos, totalizando 8 registros alem da primeira ocorrencia.
- Conclusao: nome nunca pode ser a chave forte. CNPJ/CPF normalizado exige fila de duplicidade quando repetido.

### Alunos

- `Aluno.Nome`: 6.642 preenchidos, 6.406 distintos.
- 222 nomes repetidos, totalizando 236 registros alem da primeira ocorrencia.
- `Aluno.CPFResponsavel`: 6.651 preenchidos, 6.204 distintos.
- 412 CPFs repetidos, totalizando 447 registros alem da primeira ocorrencia.
- Conclusao: o CPF do responsavel identifica o responsavel compartilhado por varios alunos; nao identifica o aluno.
- `Aluno.Escola.ID`: 6.651 preenchidos, 72 escolas distintas.

### Pagamentos e parcelas

- `TBL_PAGAMENTO.ID`: unico na origem.
- `Pagamento_CliAsaas_ID`: 1.122 preenchidos, 450 vazios, 2 IDs repetidos.
- `Pagamento.Aluno_ID`: 1.568 preenchidos e 4 vazios; repeticao e esperada porque um aluno pode ter varios acordos.
- `Pagamento.Escola_ID`: 1.571 preenchidos e 1 vazio; repeticao e esperada porque uma escola tem varios acordos.
- `TBL_PAGAMENTO_LISTAGEM.ID`: unico na origem.
- `Pagamento_Listagem.Pagamento.ID`: 15.529 preenchidos, 6 vazios; 1.508 acordos com itens de parcela.
- `Pagamento_Listagem.Parcela_Numero`: 15.534 preenchidos, 1 vazio; nao e chave isolada, deve ser unica dentro do acordo.

## Decisoes de modelagem

1. Preservar IDs legados como chaves de origem, sem usa-los como PK do novo banco.
2. Gerar UUID interno para escola, cliente, aluno, acordo, parcela, cobranca e pagamento.
3. Aplicar unicidade forte ao documento normalizado somente depois de separar CPF/CNPJ e revisar os 7 conflitos de CNPJ.
4. Aplicar unicidade de parcela por `(agreement_id, installment_number)`, nunca por numero da parcela isolado.
5. Tratar IDs Asaas duplicados como conflito de integracao, nao sobrescrever automaticamente.
6. Criar fila de `duplicate_candidates`/reconciliacao antes do cutover.
7. Excluir credenciais encontradas em dados legados da migracao; tokens e chaves devem ser revogados.
