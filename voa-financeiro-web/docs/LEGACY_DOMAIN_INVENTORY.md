# Inventario do legado e regras de negocio

## Escopo analisado

As fontes legadas foram preservadas em `../_legacy-powerapps/` e analisadas somente para reconstruir o dominio:

- Canvas App financeiro `Compras`/`Financeiro`, com fontes em `projects-and-sources/Compras/build_src/Src`.
- App VOA V2, com fontes em `projects-and-sources/Microsoft.PowerApps` e `projects-and-sources/VOA`.
- Metadados Dataverse, schemas XML, TableDefinitions, backups e logs.
- Workbook `root-exports/VOA.xlsx`, com 35 abas e dados de cadastro, contatos, dividas, pagamentos, processos e financeiro.
- Documentacao de export/import, retencao, problemas de duplicidade e sincronizacao.

## Mapa funcional observado

### App Financeiro/Compras

- `Screen_Login`: autentica usuario legado e define contexto de acesso.
- `Screen_MenuPrincipal`: hub de navegacao para financeiro, cadastros, pedidos e relatorios.
- `Screen_CadCli` e telas de cliente: cadastro de cliente/fornecedor e dados mestres.
- `Screen_CadastroParcelas`: acordo e geracao/edicao de parcelas.
- `Screen_Pagamento`, `Screen_Edicaodepagamento`, `Screen_Pagamentorecorente`, `Screen_Pagamentodevolvido`: ciclo financeiro de pagamento.
- `Screen_Financeiro`, `Screen_Relatorio`, `Screen_RHPagamentos`: consultas, relatorios e acompanhamento.
- `Screen_ImportExtrato` e `Screen_ImportExtrato_V2`: importacao/conferencia de extratos.
- `Screen_AprovacaoComite` e `Screen_Aprovacaopedido`: aprovacao operacional.

### App VOA V2

- Cadastros de escolas, alunos e contatos.
- Listagens de alunos, escolas, contatos, dividas e pagamentos.
- Processos juridicos, publicacoes, agenda e consultas de contato.
- Fluxos de criacao manual de boletos e exclusao de cliente.
- Tela de baixas com retencao por parcela e repasse.

## Fluxo de negocio reconstruido

```text
Escola -> Aluno -> Responsavel/Cliente -> Divida/Acordo
                                      -> Parcelas
                                      -> Cobranca Asaas/Boleto/Pix
                                      -> Pagamento/Baixa
                                      -> Retencao por parcela -> Repasse
```

Relacionamentos legados observados:

- `TBL_ALUNO.Aluno.Escola.ID` aponta para `TBL_ESCOLA.ID`.
- `TBL_ALUNO.Aluno.CPFResponsavel` identifica o responsavel financeiro em muitos fluxos, mas nao e uma chave confiavel de aluno.
- `TBL_DIVIDA.Divida.Aluno.ID` aponta para aluno.
- `TBL_DIVIDA_LISTAGEM.Divida_Listagem.Divida.ID` aponta para a divida e representa parcelas/itens de vencimento.
- `TBL_PAGAMENTO_LISTAGEM.Pagamento_Listagem.Pagamento.ID` aponta para o acordo/pagamento principal.
- `TBL_PAGAMENTO.Pagamento.Aluno_ID` e `Pagamento.Escola_ID` repetem nomes e chaves para consultas rapidas.
- `TBL_CLIENTEENDTEL` e `TBL_ENDTEL` guardam contatos/telefones em estruturas separadas.
- `TBL_CONTATO` registra historico de contatos do aluno.
- `TBL_PROCESSO`, `TBL_PROCESSODIVIDA` e `TBL_PROCESSODETALHE` relacionam cobranca juridica, divida e etapas.

## Regras financeiras identificadas

### Retencao

A retencao e configuravel por escola e aplicada parcela a parcela:

- ativacao por escola;
- percentual salvo como fracao, por exemplo `0.5` para 50%;
- meta monetaria opcional;
- retencao da parcela: `min(valor_pago * percentual, valor_que_falta_para_meta)`;
- repasse: `valor_pago - valor_retido`;
- parcelas sem retencao liberam 100%;
- o historico deve ser imutavel e recalculavel.

### Asaas e boletos

O legado usa identificadores Asaas em `Pagamento_CliAsaas_ID` e formulas/fluxos para criacao manual de boletos. A nova regra deve separar:

- cliente local;
- cliente Asaas;
- cobranca local;
- cobranca Asaas;
- boleto/linha digitavel/URL;
- eventos de webhook;
- pagamento/liquidacao.

Nenhum segredo encontrado em planilha ou export deve ser migrado. O valor de `TBL_BANCO.BANCO_APIKEY` deve ser tratado como comprometido e revogado, nao como dado de negocio.

## Problemas do legado que a nova aplicacao deve corrigir

- IDs numericos, `Title`, IDs PowerApps e GUIDs externos aparecem misturados.
- Nomes de escola, cliente e aluno sao repetidos em tabelas transacionais.
- Existem estruturas quase duplicadas, como `TBL_ALUNO`/`TBL_ALUNOS` e contatos separados.
- Houve historico de duplicidades de alunos e limite operacional de 5.000 registros no Dataverse.
- Excel/ZIP podem conter cargas incompletas mesmo quando o importador reporta sucesso.
- As formulas PowerApps possuem binding errors, referencias nulas e aliases de datasource conflitantes.
- Dados de contato sao incompletos e precisam de validacao antes de envio.

## Regra de migracao

Importar primeiro para staging, preservar a chave de origem e gerar relatorio de reconciliacao. Nao sobrescrever nem excluir fontes legadas. Dados sensiveis de autenticacao, tokens, chaves Asaas e senhas devem ser excluidos da carga e revogados quando encontrados.
