# Regras canonicas de dados

Estas regras substituem a dependencia direta dos nomes e IDs do PowerApps/Dataverse. O banco novo usa UUID interno e conserva as chaves legadas somente para rastreabilidade.

## Identidade comum

Todas as entidades de negocio devem ter:

- `id uuid`: identificador interno imutavel do novo sistema.
- `legacy_source`, `legacy_table`, `legacy_id`: chave de origem preservada.
- `created_at`, `updated_at` e, quando aplicavel, `deleted_at`.
- trilha de auditoria para criacao, alteracao, importacao e soft delete.

A combinacao `(legacy_source, legacy_table, legacy_id)` deve ser unica quando a origem existir. O ID interno nunca deve ser reutilizado.

### Proveniencia legada por tabela (2026-10-22)

| Tabela | Chave legada | Como as linhas sao enderecadas |
|---|---|---|
| `schools`, `customers`, `students`, `agreements` | `legacy_source/legacy_table/legacy_id` desde `0002`/`0004` | `INSERT ... ON CONFLICT (legacy_source, legacy_table, legacy_id)` na carga |
| `contacts` (46.829 linhas), `installments` (15.259 linhas) | desde a `0009`, com backfill | mesma chave; as linhas gravadas antes da `0009` foram carimbadas por `npm run db:backfill-legacy-provenance` (recalcula o UUID deterministico da linha de origem) |
| `payments`, `asaas_customers`, `asaas_charges` | nao tem | UUID deterministico `uuid5(carga, "aba:linha")`; o legado nao guarda id de pagamento/cobranca e o vinculo vem de `links` (`payments.installment_id = "row:installments"`) |
| `users` | `legacy_source/legacy_table/legacy_id` desde a `0010` | ainda sem carga: `TBL_USER.ID` segue em `review` porque a entrada exige politica de credencial (`password_hash` e `NOT NULL` e a senha do legado nao migra) |
| `student_contacts` | `legacy_source/legacy_table/legacy_id` desde a `0010` | ainda sem carga: a aba `TBL_ENDTEL` (47.562 linhas) nao esta mapeada |

Regra de operacao: a chave legada so vale para uma tabela quando o dicionario declara
`provides_legacy_id_for` nela. Criar a coluna sem carimbar as linhas antigas faz a carga seguinte
tratar as linhas existentes como novas - por isso a ordem e sempre
`db:migrate` -> `db:backfill-legacy-provenance --commit` -> carga.

## Escolas

Tabela canonica: `schools`.

- `id`: UUID unico da escola.
- `legacy_id`: ID de `TBL_ESCOLA`/origem preservado.
- `legal_name`: razao social obrigatoria.
- `trade_name`: nome fantasia/nome operacional.
- `document_number`: CNPJ normalizado, quando existir.
- `name_normalized`: nome sem acentos, espacos duplicados e diferenca de caixa.
- Regra de duplicidade: bloquear mesmo CNPJ; sinalizar mesmo `name_normalized` para revisao.
- O nome exibido pode mudar sem mudar o UUID.
- Uma escola possui muitos alunos, acordos, parcelas, pagamentos e configuracoes de retencao.

O nome nao deve ser a unica chave tecnica: escolas podem ter nomes semelhantes. O CNPJ e a revisao assistida de nomes formam a identidade de migracao.

## Clientes e responsaveis

Tabela canonica: `customers`.

- `id`: UUID unico do cliente/responsavel.
- `legacy_id`: ID de `TBL_CLIENTE` preservado.
- `full_name`: nome oficial.
- `name_normalized`: nome normalizado para busca e deduplicacao.
- `document_type`: `cpf` ou `cnpj`.
- `document_number`: documento somente com digitos.
- Regra forte: um CPF/CNPJ normalizado nao pode pertencer a dois clientes ativos.
- Regra de nome: nome normalizado deve ser unico dentro de um mesmo documento; nomes iguais sem documento nao podem ser fundidos automaticamente.
- Para o legado empresarial, CNPJ e suportado porque `TBL_CLIENTE` contem clientes juridicos.
- Contatos, enderecos, alunos relacionados e IDs Asaas ficam em tabelas relacionadas.

O sistema nao deve assumir que nome sozinho identifica pessoa. Quando o usuario exigir nome unico operacional, a API deve alertar duplicidade e exigir revisao, sem apagar registros.

## Alunos

Tabela canonica: `students`.

- `id`: UUID unico do aluno.
- `legacy_id`: ID de `TBL_ALUNO` preservado.
- `school_id`: escola obrigatoria.
- `customer_id`: responsavel financeiro opcional, resolvido por CPF/CNPJ e revisao.
- `full_name`, documento do aluno quando existir, matricula quando existir.
- Regra forte: `(school_id, enrollment_number)` unica quando matricula existir.
- Documento do aluno normalizado deve ser unico quando existir.
- CPF do responsavel nunca e usado como ID do aluno.
- Duplicidades sem documento/matricula vao para fila de revisao, nao para merge automatico.

## Acordos, dividas e parcelas

- `agreements.id`: UUID do acordo local.
- `agreements.legacy_id`: origem de `TBL_PAGAMENTO`/`TBL_DIVIDA` conforme mapeamento confirmado.
- `agreements.closed_at`: data de fechamento do acordo (nullable desde a `0010`); continua sem carga porque a origem (`Pagamento_DataFechamento`) ainda nao teve a semantica confirmada (fechamento x assinatura).
- `installments.id`: UUID unico de cada parcela.
- `installments.installment_number`: numero da parcela dentro do acordo.
- Regra forte: `(agreement_id, installment_number)` unica.
- `due_date`, `original_amount`, `status` e historico de alteracao sao obrigatorios.
- Uma divida legada pode virar um acordo ou um conjunto de acordos; o importador deve conservar o mapeamento original.

## Cobrancas, boletos e pagamentos

Separar sempre os identificadores:

- `charges.id`: UUID da cobranca local.
- `charges.legacy_id`: identificador legado, quando existir.
- `asaas_charges.external_id`: ID da cobranca no Asaas.
- `payments.id`: UUID do pagamento local.
- `payments.external_id`: ID do pagamento/evento externo.
- `boleto_number`, `digitable_line`, `barcode` e `invoice_url`: valores do boleto, com indices unicos quando preenchidos.
- Regra forte: cada cobranca Asaas pertence a um ambiente (`sandbox` ou `production`) e tem `external_id` unico por ambiente.
- Idempotencia obrigatoria em criacao de cobranca e processamento de webhook.
- Um webhook repetido nunca pode gerar segundo pagamento ou segunda baixa.

A identificacao exibida para o operador deve combinar um codigo curto legivel com o UUID interno, nunca depender apenas do nome do aluno ou da escola.

## Contatos e comunicacoes

- Contatos sao registros proprios, nao colunas duplicadas em cada entidade.
- `contacts.customer_id` referencia o cliente.
- Contato do aluno fica em `student_contacts.student_id` (tabela criada na `0010`): `contacts` e restrito a `customers`, porque `customer_id` e `NOT NULL` e o contato pertence ao aluno, nao ao pagador.
- Historico de contato do aluno deve ser separado de dados atuais de telefone/e-mail.
- Telefone e e-mail devem ser normalizados e marcados como primarios/verificados.
- ChatGuru e e-mail devem registrar consentimento, template, tentativa, resposta e entrega.

## Dados proibidos na migracao

Nao importar como dado operacional:

- senhas de `TBL_USER`;
- chaves API de `TBL_BANCO`;
- tokens, cookies, refresh tokens e secrets em JSON/ZIP/log;
- credenciais SMTP ou Asaas presentes em artefatos antigos.

Esses valores devem ser revogados e configurados somente no ambiente seguro do servidor.

## Ordem de carga

1. escolas e clientes;
2. contatos e enderecos;
3. alunos e vinculos responsavel/escola;
4. dividas/acordos;
5. parcelas;
6. clientes e cobrancas Asaas por mapeamento explicito;
7. pagamentos, baixas e retencao;
8. processos, historico de contato e comunicacoes;
9. auditoria e relatorio de reconciliacao.
