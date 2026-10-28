# Rotas iniciais

Todas as rotas de dominio sao versionadas sob `/api/v1`. Observabilidade, identidade, RBAC e o schema de dominio ja estao implementados; os adaptadores externos (Asaas, ChatGuru, SMTP) continuam desligados ate existir configuracao homologada.

O codigo da API separa as rotas por contexto, um arquivo por grupo: `routes/ops.ts` (saude, webhook e operacao da fila), `routes/catalog.ts`, `routes/finance.ts`, `routes/migration.ts`, `routes/reconciliation.ts` e `routes/identity.ts` (sessao e auditoria). `app.ts` so compoe: registra os plugins de plataforma, monta o `RouteDeps` (pool + config + executor de `PATCH`) e chama um `register<Contexto>Routes` por modulo. O processo continua sendo um so - os modulos compartilham o mesmo pool e as mesmas transacoes, que e o que mantem a cadeia financeira consistente. As guardas de RBAC ficam em `http/guards.ts` e o contrato dos `PATCH`, em `http/patch-runner.ts`.

## Implementadas

- `GET /health/live`, `GET /health/ready`, `GET /api/v1`
- `POST /api/v1/auth/login` - access token de 15 min + cookie httpOnly `voa_refresh`
- `POST /api/v1/auth/refresh` - rotaciona o refresh (o token apresentado e revogado na mesma transacao)
- `POST /api/v1/auth/logout` - revoga a sessao e limpa o cookie
- `GET /api/v1/auth/me`
- `GET/POST /api/v1/schools`, `GET/POST /api/v1/customers`, `GET/POST /api/v1/students`
- `GET/POST /api/v1/customers/:customerId/contacts`
- `GET /api/v1/students/:studentId/guardians` e `GET /api/v1/students/:studentId/contacts` - responsavel
  (`guardians`, migration `0011`) e contatos do aluno (`student_contacts`, `0010` + `0011`); um id de aluno
  malformado responde `400` mesmo sem banco
- `GET /api/v1/guardians/customer-candidates` - fila de promocao responsavel -> cliente (ver a secao propria)
- `GET/POST /api/v1/agreements`, `GET/POST /api/v1/installments`, `GET/POST /api/v1/payments`
- `POST /api/v1/customers/:id/asaas` e `POST /api/v1/installments/:id/charge` (`finance:write`) - os dois
  produtores da fila de saida: sincronizar o cliente e gerar a cobranca (ver a secao "Fila de saida")
- `GET /api/v1/schools/:schoolId/retention` - `retentionEnabled`, `retentionPercentage`, `targetAmount`,
  `retainedAmount` (**liquido**: `retention` soma, `release` e `reversal` subtraem), e o detalhe
  `retentionAmount` / `releasedAmount` / `reversedAmount`
- `PATCH /api/v1/schools|customers|students|guardians|student-contacts/:id` (`catalog:write`) e
  `PATCH /api/v1/agreements|installments|payments/:id` (`finance:write`)
- `POST /api/v1/migrations/batches` e `GET /api/v1/migrations/batches[/:id]` (`migration:write` / `read`)
- `POST /api/v1/migrations/batches/:id/validate|commit` e `POST /api/v1/migrations/errors/:id/resolve` (`migration:write`), com `GET /api/v1/migrations/batches/:id/errors` (`read`)
- `GET /api/v1/reconciliation/post-load[/:check]` - conciliacao pos-corte somente leitura (ver a secao propria)
- `GET /api/v1/audit-logs` (somente `admin`)
- `POST /api/v1/webhooks/asaas` (exige o token `ASAAS_WEBHOOK_TOKEN`)
- `GET /api/v1/ops/outbox` (`read`) e `POST /api/v1/ops/outbox/:id/retry` (`audit`) - operacao da fila
  de saida do Asaas (ver a secao propria)
- `GET /api/v1/ops/asaas-events` (`read`) e `POST /api/v1/ops/asaas-events/:id/retry` (`audit`) -
  operacao da fila de entrada do Asaas (ver a secao propria)

## Contrato dos `PATCH`

O corpo e **parcial**: so os campos enviados sao gravados (mais `updated_at`), o que nao veio fica
como esta e `null` limpa uma coluna anulavel. A validacao (`zod`, `.partial().strict()`) e a
allowlist de colunas vivem em `apps/api/src/domain/patch-specs.ts`; nada que chegue no corpo entra no
`SET` sem passar por aquele mapa.

| Situacao | Status | `code` |
|---|---|---|
| campo desconhecido, uuid invalido ou valor fora de regra | 400 | `INVALID_REQUEST` |
| corpo `{}` | 400 | `EMPTY_PATCH` |
| referencia inexistente (`schoolId`/`customerId`/`studentId`) | 400 | `INVALID_REFERENCE` |
| linha inexistente ou apagada logicamente | 404 | `NOT_FOUND` |
| violacao de unicidade | 409 | `CONFLICT` |

Cada escrita bem-sucedida grava `<entidade>.updated` em `audit_logs` com `metadata.fields` (nomes dos
campos alterados) e `metadata.actorId`. As chaves estruturais ficam fora de proposito: `id`,
`created_at`, `updated_at`, `legacy_*`, `agreements.school_id|customer_id` e
`installments.agreement_id|installment_number`.

Campos por entidade:

| Entidade | Campos |
|---|---|
| `schools` | `legalName`, `tradeName`, `documentNumber`, `status`, `retentionEnabled`, `retentionTargetAmount`, `retentionPercentage` |
| `customers` | `fullName`, `documentNumber`, `email`, `phone`, `status` |
| `students` | `schoolId`, `customerId`, `fullName`, `documentNumber`, `enrollmentNumber`, `status` |
| `guardians` | `customerId`, `fullName`, `documentNumber`, `documentRg`, `maritalStatus`, `occupation`, `isFinancial`, `isVerified` |
| `studentContacts` | `type`, `value`, `isPrimary`, `isVerified`, `status` |
| `agreements` | `studentId`, `reference`, `totalAmount`, `installmentsCount`, `status`, `closedAt` |
| `installments` | `dueDate`, `originalAmount`, `status` |
| `payments` | `status`, `retainedAmount`, `releasedAmount`, `retentionStatus`, `retentionPercentage`, `retentionApprovedAt`, `retentionScheduledMonth`, `retentionReleasedAt` |

`retentionPercentage` e uma **fracao** (`0.25` = 25%), no formato `numeric(5, 4)`: em `payments` desde a
migration `0008`, em `schools` desde a `0015`. O da **escola** e a fonte que o consumidor de
`asaas_events` usa para lancar retencao (secao 5 de `docs/ASAAS_EVENT_RULES.md`); `NULL` significa
"escola sem percentual" e `retentionEnabled` e o interruptor. `retentionScheduledMonth` aceita apenas
`AAAA-MM` e `retentionStatus` aceita `pending_approval`, `approved`, `released`, `not_applicable` ou
`direct_payment`.
`GET /api/v1/payments` devolve as mesmas colunas `retention*`, entao a tela nao precisa de uma
segunda leitura para acompanhar o repasse.

Campos com regra propria:

- `agreements.closedAt`: data de encerramento em ISO 8601 (`2026-10-27T00:00:00Z`); `null` reabre. A
  coluna **nao** e preenchida pela migracao (`Pagamento_DataFechamento` ficou `defer`, ver
  `docs/FIELD_MAPPING_TRIAGE.md`).
- `guardians.customerId`: promocao assistida do responsavel a cliente pagador (o loader sempre deixa
  `null`); `null` desfaz o vinculo. E a trilha de conciliacao guardiao <-> cliente. O `PATCH`
  **recusa** (`409 CUSTOMER_NOT_PAYER`) um cliente que nao pague nenhum acordo do aluno do guardiao:
  dos 26.264 clientes, 24.696 sao escolas/empresas de `TBL_CLIENTE`, e promover um responsavel a
  escola nao e conciliacao. Um id inexistente responde `400 INVALID_REFERENCE`.
- `studentContacts.type`: `phone`, `email`, `address` ou `other` (os tres primeiros sao os rotulos que
  o legado carrega); `studentContacts.status`: `active` ou `inactive` (preserva os 5.695 contatos
  `DESATIVADO` sem apagar linha).

## Contrato da migracao (staging)

As rotas `/api/v1/migrations` **nao** executam as fases da migracao: perfil, staging, validacao e
carga continuam em `scripts/*.py` (`docs/MIGRATION_WORKFLOW.md`), que sao os unicos que conhecem o
dicionario de campos. A API registra a fonte, mostra o que o validador gravou, fecha achado na
triagem e sela o lote. Nenhuma tabela canonica e escrita por elas, e o `payload` das linhas de
staging nunca sai na resposta (so metadados, codigo, campo e mensagem do achado).

| Rota | Permissao | O que faz |
|---|---|---|
| `POST /migrations/batches` | `migration:write` | registra a fonte em `profiled`; idempotente por `source_name` + `source_hash` (sha256 hex do arquivo) |
| `GET /migrations/batches?status=&limit=` | `read` | lotes recentes com total de linhas e de achados abertos |
| `GET /migrations/batches/:id` | `read` | contagens por status de linha, achados por severidade, reconciliacao e os dois vereditos do gate |
| `GET /migrations/batches/:id/errors?severity=&resolved=` | `read` | achados para triagem, com aba/linha de origem |
| `POST /migrations/errors/:id/resolve` | `migration:write` | grava `resolved_at` e a nota em `details.resolution`; repetir devolve `duplicate: true` |
| `POST /migrations/batches/:id/validate` | `migration:write` | recalcula o gate e sela o lote como `validated` |
| `POST /migrations/batches/:id/commit` | `migration:write` | recalcula o gate e sela o lote como `committed` (grava `completed_at`) |

O gate le `migration_rows`, `migration_errors` e `reconciliation_reports`, nunca o workbook:

| Bloqueio | Regra |
|---|---|
| `NO_ROWS` | o lote nao tem linha estagiada |
| `ROWS_IN_ERROR` | alguma linha esta com `status = 'error'` |
| `OPEN_BLOCKING_FINDINGS` | achado `blocking` com `resolved_at IS NULL` |
| `OPEN_ERROR_FINDINGS` | achado `error` com `resolved_at IS NULL` |
| `NO_RECONCILIATION` | so no `commit`: o lote nao tem `reconciliation_reports` |

`warning` nao bloqueia, porque o validador tambem nao marca a linha nesse caso. Resolver o achado
nao reescreve a linha do staging: se ela continua `error`, `validate` segue respondendo 409.

| Situacao | Status | `code` |
|---|---|---|
| corpo/identificador invalido, `status` ou `resolved` fora do enum | 400 | `INVALID_REQUEST` |
| lote ou achado inexistente | 404 | `NOT_FOUND` |
| lote ja `committed`, `rolled_back` ou `failed` (ou `commit` fora de `validated`/`approved`) | 409 | `INVALID_STATUS` |
| gate com bloqueio aberto | 409 | `BATCH_NOT_READY` (com `blockers` e `counts`) |

O `commit` fecha o lote, **nao** carrega dado: a carga continua em
`npm run db:load-canonical-commit`. Cada transicao grava `migration.batch.registered`,
`migration.batch.validated`, `migration.batch.committed` ou `migration.finding.resolved` em
`audit_logs`.

## Conciliacao pos-corte

Leitura pura (`read`, qualquer papel autenticado): confere o que a carga **deixou gravado**, sem
corrigir nada e sem guardar snapshot.

- `GET /api/v1/reconciliation/post-load` - as cinco verificacoes + a cobertura por entidade;
- `GET /api/v1/reconciliation/post-load/:check` - detalhe paginado (`limit`, teto de 200).

| Verificacao | O que compara | Esperado |
|---|---|---|
| `legacy_provenance` | linhas de `schools`, `customers`, `students`, `guardians`, `contacts`, `student_contacts`, `agreements` e `installments` com `legacy_source` nulo | 0 |
| `legacy_key_resolves` | linhas canonicas cuja chave `(legacy_table, legacy_id)` nao existe em `migration_rows` | 0 |
| `agreement_total` | `agreements.total_amount` x soma de `installments.original_amount` (tolerancia de meio centavo) | 0 |
| `agreement_installments` | `agreements.installments_count` x parcelas gravadas | 0 |
| `guardian_customer_link` | `guardians.customer_id` de cliente que nao paga nenhum acordo do aluno | 0 |

`payments` fica fora da proveniencia porque nao tem colunas `legacy_*` (nasce da aplicacao e do
webhook Asaas; a reconciliacao dele e por `external_id`), e `users` fica fora porque e criado por
`auth:create-admin` - usuario sem `legacy_source` e o esperado. A cobertura (`canonicalRows`,
`stagedRows`, `pendingCanonicalKeys`) e **informativa**: `pendingCanonicalKeys` conta linhas
estagiadas que o dicionario descartou ou adiou de proposito, nao uma divergencia.

| Situacao | Status | `code` |
|---|---|---|
| verificacao fora das cinco declaradas | 400 | `INVALID_REQUEST` |
| qualquer divergencia encontrada | 200 | corpo com `ok: false`, `divergent` e o item por verificacao |

## Promocao responsavel -> cliente

A `0011` nasceu com `guardians.customer_id` nulo porque **nome do legado nunca vira cliente**. Esta
secao e o caminho assistido para uma pessoa decidir o vinculo, e nao uma regra que o decida.

- `GET /api/v1/guardians/customer-candidates` (`read`, qualquer papel autenticado) - fila dos 6.347
  guardioes, com `status`, `limit` (teto 200) e `offset`;
- `PATCH /api/v1/guardians/:id` com `customerId` (`catalog:write`) - grava o vinculo confirmado.

A SPA consome a fila **e** a escrita: o painel "Responsaveis" (`apps/web/src/main.tsx`) abre sem filtro
(a ordenacao da API ja traz `single` primeiro), mostra `counts` em chips por situacao, a frase de
`titles` em cada linha e, por linha, o botao que envia `{ "customerId": "...", "isVerified": true }` ao
`PATCH` abaixo. `single` confirma em um clique; `ambiguous` exige escolher o pagador antes de confirmar,
porque duas linhas podem ser a mesma pessoa repetida por acordo (o `agreements` desempata). O item ja
vinculado tem `Desvincular`, que so grava no segundo toque e envia
`{ "customerId": null, "isVerified": false }` (a verificacao era daquele par). A trava continua no
servidor: a tela so encurta a decisao.

O universo de candidatos **nao** e a tabela `customers`: e `agreements.customer_id` do aluno do
guardiao. Dos 26.264 clientes, 24.696 vem de `TBL_CLIENTE` e sao escolas/empresas (CNPJ); os 1.568
restantes sao o pagador sintetizado de `TBL_PAGAMENTO`. Comparar nome de pessoa com razao social so
produziria ruido, e a comparacao de CPF nunca casa: os guardioes tem CPF (11 digitos) e os clientes
de `TBL_CLIENTE` tem CNPJ (14).

| `status` | Significado | Guardioes (canonico local, 2026-10-27) |
|---|---|---|
| `single` | um unico pagador do aluno tem o nome do responsavel | 274 |
| `ambiguous` | duas ou mais linhas de pagador com esse nome (a mesma pessoa repetida por acordo) | 102 |
| `no_match` | o aluno tem pagador, mas com outro nome (em geral o proprio aluno) | 774 |
| `no_payer` | o aluno nao tem acordo com pagador | 5.197 |
| `linked` | `customer_id` ja preenchido | 0 |

Nome e comparado no banco: `translate` (acento -> ASCII) -> `lower` -> espacos colapsados ->
`btrim`. A ordem importa porque o banco local roda em collation `C`, onde `lower('É')` nao rebaixa
nada; `JOSÉ DA SILVA` e `José da Silva` casam, e o teste de integracao cobre os dois.

| Situacao | Status | `code` |
|---|---|---|
| `status` desconhecido no query | 400 | `INVALID_REQUEST` |
| `customerId` que nao paga acordo do aluno | 409 | `CUSTOMER_NOT_PAYER` |
| `customerId` inexistente ou soft-deleted | 400 | `INVALID_REFERENCE` |
| guardiao inexistente | 404 | `NOT_FOUND` |

Vincular **nao** marca `isVerified` sozinho: o corpo do PATCH envia os dois campos quando a tela
confirma o par (`{ "customerId": "...", "isVerified": true }`), e `customerId: null` desfaz. Um
vinculo gravado por fora da API aparece na quinta verificacao do relatorio pos-corte.

## Fila de saida (outbox)

As chamadas de **saida** ao Asaas nao viram rota REST: entram numa fila dentro do banco
(`outbox_events`, migration `0012`) e saem por um worker no mesmo processo. O desenho completo esta em
`docs/OUTBOX_DESIGN.md`; o que a operacao precisa saber:

- `GET /api/v1/ops/outbox` (`read`) - `counts` por status, `oldestPendingAgeSeconds`,
  `oldestProcessingAgeSeconds` e as 10 linhas `dead` mais recentes. Pendente velho e o sinal de alarme:
  significa worker parado ou provedor recusando tudo;
- `POST /api/v1/ops/outbox/:id/retry` (`audit`, hoje so `admin`) - reabre **somente** linha `dead`
  (`attempts = 0`, `available_at = now()`) e audita `outbox.retried` com o `previousError`.

| Situacao | Status | `code` |
|---|---|---|
| id fora do formato uuid | 400 | `INVALID_REQUEST` |
| linha inexistente | 404 | `NOT_FOUND` |
| linha em `pending` ou `processing` | 409 | `OUTBOX_NOT_DEAD` |
| banco indisponivel | 503 | `DATABASE_UNAVAILABLE` |

Os dois produtores sao **acoes explicitas** (decisao da secao 15, item 1 do desenho): cobrar nunca e
efeito colateral de criar parcela nem de importar o legado.

- `POST /api/v1/customers/:id/asaas` (`finance:write`) - enfileira `asaas.customer.create` com
  `dedupe_key = asaas.customer.create:<customer_id>`. Cliente que ja tem linha em `asaas_customers`
  responde `200 { queued: false, synced: true, asaasCustomerId, externalId }`; o primeiro pedido
  responde `202 { queued: true, dedupeKey }`;
- `POST /api/v1/installments/:id/charge` (`finance:write`; corpo `{ "billingType": "BOLETO" | "PIX" |
  "CREDIT_CARD" | "UNDEFINED" }`, default `UNDEFINED` - o pagador escolhe na fatura) - enfileira
  `asaas.charge.create` com `dedupe_key = asaas.charge.create:<installment_id>` e o snapshot de
  valor/vencimento. `202` quando a linha nasce, `200 { queued: false }` quando a intencao ja estava na
  fila (o segundo `POST` nao duplica cobranca).

| Situacao | Status | `code` |
|---|---|---|
| corpo ou `id` invalido | 400 | `INVALID_REQUEST` |
| cliente ou parcela inexistente | 404 | `CUSTOMER_NOT_FOUND` / `INSTALLMENT_NOT_FOUND` |
| parcela fora de `pending` ou com valor zero | 409 | `INSTALLMENT_NOT_BILLABLE` |
| cliente sem `asaas_customers` | 409 | `CUSTOMER_NOT_SYNCED` |
| banco indisponivel | 503 | `DATABASE_UNAVAILABLE` |

Sem `ASAAS_API_KEY` a API sobe, o worker fica idle e as linhas ficam `pending`. Reenviar uma cobranca
que morreu em `dead` e sempre `POST /api/v1/ops/outbox/:id/retry`, nunca um segundo `/charge`.

## Fila de entrada (`asaas_events`)

O caminho de **entrada** e o inverso: o Asaas chama `POST /api/v1/webhooks/asaas`, a rota grava o
payload cru em `asaas_events` e responde `202`; um segundo laco no mesmo processo aplica o evento em
`installments.status`, `payments` e `asaas_charges.status`. A regra evento -> estado, o que vira
`stale`/`ignored`/`orphan` e o desenho do ledger de retencao estao em `docs/ASAAS_EVENT_RULES.md`; o
que a operacao precisa saber:

- `GET /api/v1/ops/asaas-events` (`read`) - `counts` (`pending`, `processed`, `failed`),
  `oldestPendingAgeSeconds` e as 10 linhas `failed` mais recentes (`id`, `eventType`,
  `externalChargeId`, `attempts`, `failureReason`, `createdAt`). Pendente velho e o sinal de alarme:
  significa consumidor parado, e o provedor descarta o evento depois de 14 dias;
- `POST /api/v1/ops/asaas-events/:id/retry` (`audit`, hoje so `admin`) - reabre **somente** linha
  `failed_at IS NOT NULL` (`attempts = 0`, `failed_at` e `failure_reason` limpos) e audita
  `asaas_event.retried` com o `previousError`.

| Situacao | Status | `code` |
|---|---|---|
| id fora do formato uuid | 400 | `INVALID_REQUEST` |
| evento inexistente | 404 | `NOT_FOUND` |
| evento em `pending` ou ja processado | 409 | `ASAAS_EVENT_NOT_FAILED` |
| banco indisponivel | 503 | `DATABASE_UNAVAILABLE` |

Reaplicar o evento e idempotente por construcao - o estado e absoluto, nao incremental: `payments` e
gravado com `ON CONFLICT (source, external_id)`, e um `eventType` cujo estado de origem ja nao bate
vira `stale` (no-op auditado) em vez de reabrir uma parcela estornada. `attempts >=
WEBHOOK_RETRY_LIMIT` carimba `failed_at`; sem `ASAAS_EVENTS_WORKER_ENABLED=true` o webhook continua
gravando e a fila so cresce, o que aparece no `oldestPendingAgeSeconds`. O lancamento em
`retention_ledger` fica atras de `RETENTION_LEDGER_ENABLED` (**default `false`**): ligado, o evento que
confirma dinheiro lanca `retention` pelo `schools.retentionPercentage` da escola (`PATCH
/api/v1/schools/:id`) e o estorno lanca `reversal`; escola sem percentual ou com `retentionEnabled =
false` vira `payments.retentionStatus = 'not_applicable'`, sem lancamento.

## Permissoes (RBAC)

As permissoes ficam em `apps/api/src/auth/roles.ts` e sao conferidas antes de tocar no banco:

| Permissao | Rotas | Papeis |
|---|---|---|
| `read` | todas as leituras | `admin`, `finance`, `operator`, `viewer` |
| `catalog:write` | `schools`, `customers`, `contacts` (`POST`), `students` (`POST`) e `schools`, `customers`, `students`, `guardians`, `student-contacts` (`PATCH`; o de `guardians` inclui a trava de pagador da promocao) | `admin`, `operator` |
| `finance:write` | `agreements`, `installments`, `payments` (`POST` e `PATCH`), `POST /customers/:id/asaas` e `POST /installments/:id/charge` | `admin`, `finance` |
| `migration:write` | registro do lote, `validate`, `commit` e resolucao de achado | `admin` |
| `audit` | `GET /audit-logs` | `admin` |

Um usuario sem papel recebe 403 (`FORBIDDEN`). Cada escrita aceita registra o evento em
`audit_logs` (`customer.created`, `customer.updated`, `payment.created`, ...), junto com
`auth.login.succeeded`, `auth.login.failed`, `auth.refresh`, `auth.refresh.rejected` e `auth.logout`.

## Contratos pendentes

- `POST /api/v1/schools/:id/retention/recalculate`;
- `GET /api/v1/billing/asaas/charges/:id` (a **saida** para o Asaas nao vira rota: e o outbox);
- `POST /api/v1/communications/email`, `POST /api/v1/communications/chatguru`,
  `POST /api/v1/webhooks/chatguru`.
