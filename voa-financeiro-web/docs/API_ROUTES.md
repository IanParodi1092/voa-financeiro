# Rotas iniciais

Todas as rotas de dominio serao versionadas sob `/api/v1`. Nesta fundacao, apenas as rotas de observabilidade e o identificador da API estao implementados; os contratos abaixo orientam as proximas fases.

- `GET /health/live`
- `GET /health/ready`
- `GET /api/v1`
- `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`
- `GET/POST /api/v1/schools`, `GET/PATCH /api/v1/schools/:id`
- `GET/POST /api/v1/customers`, `GET/PATCH /api/v1/customers/:id`
- `GET/POST /api/v1/students`, `GET/PATCH /api/v1/students/:id`
- `GET/POST /api/v1/agreements`, `GET/PATCH /api/v1/agreements/:id`
- `GET/POST /api/v1/installments`, `GET/PATCH /api/v1/installments/:id`
- `GET/POST /api/v1/payments`, `GET/PATCH /api/v1/payments/:id`
- `GET /api/v1/schools/:id/retention`, `POST /api/v1/schools/:id/retention/recalculate`
- `POST /api/v1/billing/asaas/customers`, `POST /api/v1/billing/asaas/charges`, `GET /api/v1/billing/asaas/charges/:id`, `POST /api/v1/webhooks/asaas`
- `POST /api/v1/communications/email`, `POST /api/v1/communications/chatguru`, `POST /api/v1/webhooks/chatguru`
- `POST /api/v1/migrations/batches`, `POST /api/v1/migrations/batches/:id/validate`, `POST /api/v1/migrations/batches/:id/commit`, `GET /api/v1/migrations/batches/:id/reconciliation`
- `GET /api/v1/audit-logs`