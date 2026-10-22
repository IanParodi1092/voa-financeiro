# Triagem das pendencias `review` do dicionario (fase 2)

- Data da triagem: `2026-10-22`
- Status: **classes A, B e E aplicadas** (22 colunas saiu de `review`), migration `0009` criada e backfill de proveniencia executado; classe A' (`Pagamento_Nome -> agreements.reference`) segue aguardando confirmacao
- Dicionario: `scripts/legacy_field_map.json` (60 abas, 856 colunas: 38 `map`, 78 `ignore`, 734 `defer`, 6 `review`)
- Lote de staging consultado: `4609c071-03c3-47fb-beff-5c3bcad6367e` (`committed`, 546.346 linhas) no Postgres local
- Relatorios de referencia: `docs/FIELD_MAPPING_DICTIONARY.md` (gerado), `docs/CANONICAL_LOAD_REPORT.md`, `docs/STAGING_VALIDATION_REPORT.md`
- Schema comparado: `apps/api/migrations/0001..0009`. A `0009` passou a prover `installments.legacy_*` e `contacts.legacy_*`; seguem sem coluna `agreements.closed_at`, `users.legacy_id`, contato de aluno e endereco/contato de escola

Este documento responde duas perguntas por coluna: **o que a coluna e** (com dado do proprio lote, nao com o nome) e **qual decisao fecha a pendencia**, junto do efeito no portao de aprovacao. Nada aqui grava no banco: as consultas foram `select` no staging e as propostas sao edicoes no JSON do dicionario.

## Leitura rapida

- **22 das 31** colunas sairam de `review` com a evidencia que ja existia (classes A, B e E): 6 sem destino canonico, 10 herdando a decisao de 2026-09-25 e 6 de endereco de escola sem tabela.
- **6 continuam bloqueando de proposito**: 2 sao politica de identidade (CPF e nome do responsavel financeiro) e 4 dependem de schema novo (`agreements.closed_at`, contato de aluno, `users.legacy_id` e a classe A' ainda nao confirmada).
- O portao continua em `exit 2` (6 itens). O que mudou e o que ele mede: as 22 colunas agora estao descritas no dicionario em vez de esperar decisao.
- A unica proposta que muda dado canonico em carga futura e `TBL_PAGAMENTO.Pagamento_Nome -> agreements.reference` (hoje nenhuma coluna escreve em `agreements.reference`). Ela entra como `status: "proposed"`, que tambem bloqueia, ate o operador confirmar.
- `TBL_DIVIDA` (6.868 linhas) e `TBL_DIVIDA_LISTAGEM` (42.886 linhas) continuam fora do canonico (`no_mapping` no relatorio da carga) e agora estao registradas assim no dicionario (`defer: no_canonical_destination`). Isso nao e pendencia de dicionario: e escopo - inadimplencia nao esta modelada.

## Resumo por classe

| Classe | Itens | O que e | Decisao | Status |
|---|---:|---|---|---|
| A | 6 | semantica agora comprovada, sem destino canonico | `ignore`/`defer` com motivo do vocabulario | aplicada |
| A' | 1 | semantica comprovada **e** destino canonico livre | `map: agreements.reference` com `status: proposed` | pendente (aguarda o operador) |
| B | 10 | herdam a decisao de 2026-09-25 (`agreements` vem de `TBL_PAGAMENTO`) | `defer: no_canonical_destination` | aplicada |
| C | 2 | politica de identidade (nome e CPF do responsavel) | manter `review` | bloqueada por politica |
| D | 6 | exigem migration ou dependem da classe B | migration + backfill | 2 aplicadas na `0009`, 1 fechada por B, 3 pendentes |
| E | 6 | endereco de escola: semantica clara, tabela inexistente | `defer: address_not_modeled` | aplicada |

### O que esta aplicado (2026-10-22)

- 22 colunas reescritas em `scripts/legacy_field_map.json` (A + B + E), com nota de evidencia em cada uma e sem mudar nenhum `map` existente.
- `TBL_DIVIDA_LISTAGEM.ID` saiu de `review` junto com a classe B: com a aba fora do canonico o id do item nao tem destino, entao o gap `installments_legacy_id` nao se aplica a ele.
- Gap `agreements_source_resolution` mantido como referencia, com descricao reescrita ("resolvido em 2026-09-25"); gaps `installments_legacy_id` e `contacts_legacy_id` marcados como resolvidos pela `0009` + backfill.
- Migration `apps/api/migrations/0009_contacts_installments_legacy_provenance.sql`: colunas `legacy_source/legacy_table/legacy_id` + indice unico em `contacts` e `installments`.
- `scripts/backfill_legacy_provenance.py` (+ `npm run db:backfill-legacy-provenance`): carimbou 46.829 `contacts` e 15.259 `installments` (0 divergencias, 0 a carimbar na segunda rodada) e as duas colunas `ID` viraram `map` com `provides_legacy_id_for`.



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

| Aba | Coluna | Evidencia no lote | Proposta |
|---|---|---|---|
| `TBL_PAGAMENTO` | `Pagamento_Nome` | 1.570 de 1.572 preenchidos; 73 rotulos: `Acordo 2023`=557, `Acordo 2024`=438, `Acordo 2025`=186, `Acordo_2022`=99, `Acordo 1`=97, `acordo 2022`=84, `Acordo2024`=21, `Acordo pago na escola`=4 | rotulo do lote de acordo; `agreements.reference` existe no schema e hoje **nenhuma** coluna escreve nela: `map: agreements.reference`, `type: text`, `normalization: collapse_ws`, `status: proposed` |

Dois cuidados:

1. 73 rotulos para 1.505 acordos: `reference` agrupa lotes (`Acordo 2024`), nao identifica acordo - a identidade continua em `agreements.legacy_id`, que vem de `TBL_PAGAMENTO.ID`.
2. A grafia varia (`Acordo_2022`, `acordo 2022`, `Acordo2024`). Unificar em `Acordo 2022`/`Acordo 2024` e decisao de produto; `collapse_ws` apenas remove espaco repetido.

## Classe B - herdam a decisao de 2026-09-25 (10)

| Aba | Colunas | Evidencia | Proposta |
|---|---|---|---|
| `TBL_DIVIDA` | `ID`, `Divida.Aluno.ID`, `Divida_Nome`, `Divida.Pagamento.ID`, `Divida.ValorOriginalTotal`, `Divida.ValorAtualizadoTotal` | `docs/CANONICAL_LOAD_REPORT.md`: `TBL_DIVIDA | no_mapping | 6.868` linhas, 0 carregadas | `defer: no_canonical_destination`, mantendo o gap `agreements_source_resolution` com nota reescrita |
| `TBL_DIVIDA_LISTAGEM` | `Divida_Listagem.Divida.ID`, `Divida_Listagem.Vencimento`, `Divida_Listagem.Valor`, `Divida_Listagem.Valor_Atualizado` | idem: `42.886` linhas, 0 carregadas | `defer: no_canonical_destination` |

O gap `agreements_source_resolution` deixou de ser duvida: `agreements` sai de `TBL_PAGAMENTO` (`provides_legacy_id_for: agreements`, 1.572 linhas -> 1.505 acordos) e `installments` de `TBL_PAGAMENTO_LISTAGEM` (15.535 -> 15.259) desde a decisao do operador em 2026-09-25. Falta registrar isso no dicionario em vez de repetir `pending_policy` em dez colunas: dividas que nunca viraram acordo ficam fora do canonico ate existir modelo de inadimplencia.

## Classe C - politica de identidade, mantida em `review` (2)

| Aba | Coluna | Evidencia | Por que nao fechar |
|---|---|---|---|
| `TBL_ALUNO` | `Aluno.Responsavel_Financeiro` | 5.840 nomes distintos | nome nunca identifica cliente; falta fluxo de revisao assistida |
| `TBL_ALUNO` | `Aluno.CPFResponsavel` | 1.091 CPFs invalidos (`DOCUMENT_INVALID`), 447 repeticoes | documento invalido nao pode vincular `customers` sozinho |

Essas duas sao tambem a guarda do dicionario: `scripts/test_build_field_dictionary.py::test_open_decisions_stay_blocked` exige que `unreliable_document_source`, `pending_policy` e `name_only_link_not_allowed` continuem como itens de politica. Trocar para `defer` quebra o teste - e a intencao do teste e impedir que a pendencia suma sem decisao.

## Classe D - exigem migration nova (6)

| Aba | Coluna | Gap | Volume no lote | O que a migration precisa |
|---|---|---|---:|---|
| `TBL_CLIENTEENDTEL` | `ID` | `contacts_legacy_id` | 54.782 ids; 46.829 contatos carregados | **resolvido**: `contacts.legacy_*` + indice unico na `0009`, carimbado pelo backfill e mapeado com `provides_legacy_id_for: contacts` |
| `TBL_PAGAMENTO_LISTAGEM` | `ID` | `installments_legacy_id` | 15.535 ids distintos; 15.259 parcelas carregadas | **resolvido**: `installments.legacy_*` + indice unico na `0009`, carimbado pelo backfill e mapeado com `provides_legacy_id_for: installments` |
| `TBL_PAGAMENTO` | `Pagamento_DataFechamento` | `agreements_closed_at` | 1.497 de 1.572 preenchidos | pendente: `agreements.closed_at` (ou `signed_at`) |
| `TBL_ENDTEL` | `ENDTEL_ALUNO_ID` | `students_contact` | 47.561 de 47.562 preenchidos em 6.894 alunos | pendente: `contacts.customer_id` e `NOT NULL`, entao contato de aluno exige tabela propria (`student_contacts`) ou `contacts` polimorfico |
| `TBL_USER` | `ID` | `users_legacy_import` | 28 usuarios | pendente: `users.legacy_id` **e** politica de credencial: o legado nao tem `password_hash` utilizavel, a entrada tem de ser convite/reset |
| `TBL_DIVIDA_LISTAGEM` | `ID` | `installments_legacy_id` | 42.886 ids distintos | **fechado pela classe B**: com a aba fora do canonico a coluna virou `defer: no_canonical_destination` e nao precisa de coluna nova |

A migration `0009` foi aplicada de forma deliberadamente estreita: so os dois `legacy_id` que davam rastreabilidade a 62.088 linhas ja carregadas. `agreements.closed_at`, `student_contacts` e `users.legacy_id` continuam em aberto - os tres exigem decisao de produto (data de fechamento, modelo de contato de aluno e politica de credencial), nao so schema.

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
| + `0009` + backfill (`contacts`/`installments.legacy_id`) | 6 | 6 | exit `2` - **estado atual** |
| + A' com `status: "proposed"` | 5 | 6 (5 `review` + 1 `MAPPING_NOT_CONFIRMED`) | exit `2` |
| + A' confirmada | 5 | 5 | exit `2` |
| + `agreements_closed_at`, contato de aluno e `users.legacy_id` | 2 | 2 | exit `2` |
| + decisao de identidade da classe C | 0 | 0 | exit `0` |

Numeros medidos no estado atual: `38 map`, `78 ignore`, `734 defer`, `6 review`, `0` problema estrutural, `0` divergencia de staging; o portao lista 6 `REVIEW_REQUIRED` (`Aluno.Responsavel_Financeiro`, `Aluno.CPFResponsavel`, `ENDTEL_ALUNO_ID`, `Pagamento_Nome`, `Pagamento_DataFechamento`, `TBL_USER.ID`).

O portao nao bloqueia a carga canonica: `scripts/load_canonical_batch.py` so exige que toda coluna `NOT NULL` sem `default` esteja coberta por `map`/`links`. O portao mede a qualidade do dicionario - e o lote de 2026-09-25 foi carregado com ele ainda fechado. Fechar as classes A, B e E e o que torna o dicionario descritivo do que ja foi carregado; as classes C e D so fecham com trabalho novo (revisao assistida e migration).

## Como foi aplicado

1. `scripts/legacy_field_map.json`: classes A, B e E reescritas com nota de evidencia por coluna (nenhum `map` existente mudou).
2. `apps/api/migrations/0009_contacts_installments_legacy_provenance.sql` + `npm run db:migrate` (local: `Migrations: 1 aplicadas, 8 ja aplicadas`).
3. `python scripts\backfill_legacy_provenance.py --commit`: `contacts` 46.829 carimbados (7.953 fora do canonico), `installments` 15.259 carimbados (276 fora do canonico), 0 divergencias; segunda rodada `0` a carimbar.
4. `TBL_CLIENTEENDTEL.ID` e `TBL_PAGAMENTO_LISTAGEM.ID` passaram a `map` com `provides_legacy_id_for` (dependem do passo 3: sem o carimbo, a carga tentaria reinserir as linhas ja gravadas e bateria na chave natural de `installments`).
5. Revalidacao:

   ```powershell
   npm run db:field-dictionary      # 38 map, 78 ignore, 734 defer, 6 review
   npm run db:field-dictionary-check # exit 2, 6 REVIEW_REQUIRED, staging_mismatches 0
   npm run test:python              # 198 testes
   python scripts\load_canonical_batch.py --json-out "$env:TEMP\voa_load.json"
   ```

   A carga em `dry-run` reusou todas as linhas (`inserted=0`, `reused=104.709`) e `canonical_before == canonical_after` em todas as tabelas: e a prova de que o backfill fechou a reconciliacao por chave legada.

Ordem obrigatoria para qualquer ambiente novo: `db:migrate` (0009) -> `db:backfill-legacy-provenance --commit` -> carga. Habilitar o provedor antes do backfill faz a carga recusar as linhas existentes como duplicidade.

Exemplo de edicao por classe (linha atual -> proposta):

```jsonc
// Classe A - TBL_ALUNO
{ "match": "Aluno_AnoDivida", "defer": "no_canonical_destination", "note": "ano de referencia da divida (2014..2022, com 1900/1969 invalidos); agreements nao tem coluna de ano" },
{ "match": "Aluno_Contrato", "ignore": "legacy_flag", "note": "booleano: 3754 false, 1 true, 2897 vazios" },

// Classe A' (so depois da confirmacao do operador) - TBL_PAGAMENTO
{ "match": "Pagamento_Nome", "map": "agreements.reference", "type": "text", "normalization": "collapse_ws", "status": "proposed", "note": "rotulo do lote de acordo ('Acordo 2024'); nao identifica o acordo, isso e agreements.legacy_id" },

// Classe B - TBL_DIVIDA
{ "match": "ID", "defer": "no_canonical_destination", "gap": "agreements_source_resolution", "note": "TBL_DIVIDA fora do canonico: agreements vem de TBL_PAGAMENTO (decisao 2026-09-25)" },

// Classe E - TBL_AUXSUBIR
{ "match": "Endereco", "defer": "address_not_modeled", "gap": "schools_contact_address" }
```

## Decisoes pedidas ao operador

1. **Classe A (6 colunas)** - **aceita** em 2026-10-22: `ignore`/`defer` como acima. Sao as unicas seis em que a semantica ficou evidente pelo dado (`Aluno_AnoDivida` e inferencia: "ano de referencia da divida").
2. **Classe A' (`Pagamento_Nome`)** - **pendente**: gravar o rotulo do lote em `agreements.reference`? Se sim, com `status: "proposed"` e depois `confirmed`. Nuance de operacao: os 1.505 acordos ja existem, e a carga reusa a linha pela chave legada, entao `reference` so e preenchida numa rodada `--commit --enrich-reused` (o `UPDATE` usa `COALESCE(coluna, %s)`, ou seja, nunca sobrescreve valor existente).
3. **Classe B (10 colunas)** - **aceita** em 2026-10-22: `TBL_DIVIDA`/`TBL_DIVIDA_LISTAGEM` registradas como fora do canonico (inadimplencia nao modelada) e gap `agreements_source_resolution` reescrito como resolvido. Se um dia dividas entrarem no canonico, o caminho e nova entidade `debts` + `debt_items` e as 10 colunas voltam a `map`.
4. **Classe E (6 colunas)** - **aceita** em 2026-10-22: `defer: address_not_modeled`. Quando endereco de escola entrar, o caminho e migration de `school_addresses` (com CEP normalizado para 8 digitos); o `defer` de hoje nao impede.
5. **Classe C (2 colunas)** - **em aberto**: manter bloqueado, criar fluxo de revisao assistida de responsavel financeiro, ou aceitar vinculo automatico por CPF valido (9.000+ linhas) e nome como desempate?
6. **Classe D** - **parcialmente aceita** em 2026-10-22: a migration `0009` saiu so com `installments.legacy_id` + `contacts.legacy_id` (as duas que davam rastreabilidade ao que ja estava carregado). `agreements.closed_at`, `student_contacts` e `users.legacy_id` seguem em aberto; sem elas o portao fica em `2`, mas nada impede a operacao das telas.

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

