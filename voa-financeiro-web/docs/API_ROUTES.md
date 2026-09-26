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
- `GET /api/v1/audit-logs` (somente `admin`)
- `POST /api/v1/webhooks/asaas` (exige o token `ASAAS_WEBHOOK_TOKEN`)

## Permissoes (RBAC)

As permissoes ficam em `apps/api/src/auth/roles.ts` e sao conferidas antes de tocar no banco:

| Permissao | Rotas | Papeis |
|---|---|---|
| `read` | todas as leituras | `admin`, `finance`, `operator`, `viewer` |
| `catalog:write` | `schools`, `customers`, `contacts`, `students` | `admin`, `operator` |
| `finance:write` | `agreements`, `installments`, `payments` | `admin`, `finance` |
| `audit` | `GET /audit-logs` | `admin` |

Um usuario sem papel recebe 403 (`FORBIDDEN`). Cada escrita aceita registra o evento em
`audit_logs` (`customer.created`, `payment.created`, ...), junto com `auth.login.succeeded`,
`auth.login.failed`, `auth.refresh`, `auth.refresh.rejected` e `auth.logout`.

## Contratos pendentes

- `PATCH /api/v1/schools|customers|students|agreements|installments|payments/:id`;
- `POST /api/v1/schools/:id/retention/recalculate`;
- `POST /api/v1/billing/asaas/customers`, `POST /api/v1/billing/asaas/charges`,
  `GET /api/v1/billing/asaas/charges/:id`;
- `POST /api/v1/communications/email`, `POST /api/v1/communications/chatguru`,
  `POST /api/v1/webhooks/chatguru`;
- `POST /api/v1/migrations/batches` e `POST /api/v1/migrations/batches/:id/validate|commit`
  (a fase de migracao hoje roda pelos scripts Python de `docs/MIGRATION_WORKFLOW.md`).