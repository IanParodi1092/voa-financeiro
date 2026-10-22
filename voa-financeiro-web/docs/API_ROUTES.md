# Rotas iniciais

Todas as rotas de dominio sao versionadas sob `/api/v1`. Observabilidade, identidade, RBAC e o schema de dominio ja estao implementados; os adaptadores externos (Asaas, ChatGuru, SMTP) continuam desligados ate existir configuracao homologada.

## Implementadas

- `GET /health/live`, `GET /health/ready`, `GET /api/v1`
- `POST /api/v1/auth/login` - access token de 15 min + cookie httpOnly `voa_refresh`
- `POST /api/v1/auth/refresh` - rotaciona o refresh (o token apresentado e revogado na mesma transacao)
- `POST /api/v1/auth/logout` - revoga a sessao e limpa o cookie
- `GET /api/v1/auth/me`
- `GET/POST /api/v1/schools`, `GET/POST /api/v1/customers`, `GET/POST /api/v1/students`
- `GET/POST /api/v1/customers/:customerId/contacts`
- `GET/POST /api/v1/agreements`, `GET/POST /api/v1/installments`, `GET/POST /api/v1/payments`
- `GET /api/v1/schools/:schoolId/retention`
- `PATCH /api/v1/schools|customers|students/:id` (`catalog:write`) e
  `PATCH /api/v1/agreements|installments|payments/:id` (`finance:write`)
- `POST /api/v1/migrations/batches` e `GET /api/v1/migrations/batches[/:id]` (`migration:write` / `read`)
- `POST /api/v1/migrations/batches/:id/validate|commit` e `POST /api/v1/migrations/errors/:id/resolve` (`migration:write`), com `GET /api/v1/migrations/batches/:id/errors` (`read`)
- `GET /api/v1/audit-logs` (somente `admin`)
- `POST /api/v1/webhooks/asaas` (exige o token `ASAAS_WEBHOOK_TOKEN`)

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
| `schools` | `legalName`, `tradeName`, `documentNumber`, `status`, `retentionEnabled`, `retentionTargetAmount` |
| `customers` | `fullName`, `documentNumber`, `email`, `phone`, `status` |
| `students` | `schoolId`, `customerId`, `fullName`, `documentNumber`, `enrollmentNumber`, `status` |
| `agreements` | `studentId`, `reference`, `totalAmount`, `installmentsCount`, `status` |
| `installments` | `dueDate`, `originalAmount`, `status` |
| `payments` | `status`, `retainedAmount`, `releasedAmount`, `retentionStatus`, `retentionPercentage`, `retentionApprovedAt`, `retentionScheduledMonth`, `retentionReleasedAt` |

`retentionPercentage` e uma **fracao** (`0.25` = 25%), no formato `numeric(5, 4)` da migration
`0008`; `retentionScheduledMonth` aceita apenas `AAAA-MM` e `retentionStatus` aceita
`pending_approval`, `approved`, `released`, `not_applicable` ou `direct_payment`.
`GET /api/v1/payments` devolve as mesmas colunas `retention*`, entao a tela nao precisa de uma
segunda leitura para acompanhar o repasse.

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

## Permissoes (RBAC)

As permissoes ficam em `apps/api/src/auth/roles.ts` e sao conferidas antes de tocar no banco:

| Permissao | Rotas | Papeis |
|---|---|---|
| `read` | todas as leituras | `admin`, `finance`, `operator`, `viewer` |
| `catalog:write` | `schools`, `customers`, `contacts`, `students` (`POST` e `PATCH`) | `admin`, `operator` |
| `finance:write` | `agreements`, `installments`, `payments` (`POST` e `PATCH`) | `admin`, `finance` |
| `migration:write` | registro do lote, `validate`, `commit` e resolucao de achado | `admin` |
| `audit` | `GET /audit-logs` | `admin` |

Um usuario sem papel recebe 403 (`FORBIDDEN`). Cada escrita aceita registra o evento em
`audit_logs` (`customer.created`, `customer.updated`, `payment.created`, ...), junto com
`auth.login.succeeded`, `auth.login.failed`, `auth.refresh`, `auth.refresh.rejected` e `auth.logout`.

## Contratos pendentes

- `POST /api/v1/schools/:id/retention/recalculate`;
- `POST /api/v1/billing/asaas/customers`, `POST /api/v1/billing/asaas/charges`,
  `GET /api/v1/billing/asaas/charges/:id`;
- `POST /api/v1/communications/email`, `POST /api/v1/communications/chatguru`,
  `POST /api/v1/webhooks/chatguru`.
