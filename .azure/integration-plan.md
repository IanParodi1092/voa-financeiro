# Integration Handoff

## Backend

- Folder: `voa-financeiro-web/apps/api`
- Dev: `npm --prefix voa-financeiro-web run dev:api`
- Build: `npm --prefix voa-financeiro-web --workspace @voa/api run build`
- Health: `GET /health/live`; readiness: `GET /health/ready`
- Migration: `npm --prefix voa-financeiro-web run db:migrate`

## Frontend

- Folder: `voa-financeiro-web/apps/web`
- Dev: `npm --prefix voa-financeiro-web run dev:web`
- Build: `npm --prefix voa-financeiro-web --workspace @voa/web run build`
- Current state: minimal React shell; no mock client or mock datasets exist yet.

## API routes

See `voa-financeiro-web/docs/API_ROUTES.md`. Only health and API identity routes are implemented in the foundation; domain routes are reserved for the integration/domain phases.

## Database

- PostgreSQL/Supabase is the primary database. Dataverse is not a new datastore.
- Migration directory: `voa-financeiro-web/apps/api/migrations`
- Runner: `apps/api/src/db/migrate.ts`, tracked by `schema_migrations`
- Connection variables: `DATABASE_URL`, optional `DIRECT_DATABASE_URL`
- Foundation migration creates only `audit_logs` and migration metadata. Create no seed data.

## Shared types

- Package: `voa-financeiro-web/packages/shared`
- Package name: `@voa/shared`

## Services

- Essential: Fastify API, PostgreSQL/Supabase, structured logging, environment validation, health/readiness, migration runner.
- Enhancement: React SPA shell, Asaas adapter, ChatGuru adapter, Hostinger SMTP, import/reconciliation pipeline.

No real credentials are configured and no external service was called during scaffolding.