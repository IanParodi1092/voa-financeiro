# VOA Financeiro Web

Novo monorepo TypeScript para a substituicao gradual do Canvas App. A API e o componente prioritario desta fundacao; o frontend React e um shell enxuto: login e as telas de clientes, alunos, escolas e a fila de responsaveis (leitura da fila e vinculo responsavel -> cliente).

## Execucao local

1. Instale Node.js 20+ e PostgreSQL local — o Postgres local e o alvo do projeto; nenhum provedor gerenciado e necessario.
2. Copie `.env.example` para `.env` na raiz do monorepo e ajuste apenas os valores do ambiente local (as variaveis `SUPABASE_*` do seu `.env` sao ignoradas: o schema de configuracao nao as conhece).
3. Execute `npm install` na raiz.
4. Execute `npm run db:migrate` para aplicar migrations.
5. Execute `npm run dev:api` e verifique `GET http://localhost:3000/health/live`.
6. Em outro terminal, execute `npm run dev:web` para iniciar a SPA.

Nenhuma credencial real nem dado legado versionado faz parte deste repositorio, e nenhuma chamada a Asaas/ChatGuru/SMTP acontece sem configuracao de ambiente.

## Validacao

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:integration` (testes de auth, RBAC, dominio, migracao e da fila outbox; exigem `TEST_DATABASE_URL`, ver `docs/LOCAL_DEVELOPMENT.md`; sem ela o bloco e ignorado)
- `npm run test:python` (scripts de migracao; requer `scripts/requirements.txt`)

## Migracao do legado

- `docs/MIGRATION_WORKFLOW.md` descreve fases, regras de seguranca e comandos.
- `docs/STAGING_VALIDATION_REPORT.md` traz o relatorio da ultima validacao de staging.
- `docs/FIELD_MAPPING_DICTIONARY.md` traz o dicionario da fase 2 (toda coluna legada com decisao, destino, tipo e pendencia).
- `docs/FIELD_MAPPING_TRIAGE.md` faz a triagem das colunas `review`: o que cada uma e no dado, a decisao por classe e o impacto no portao de aprovacao. Em 2026-10-27 o portao fechou em `0 review` (classes A, A', B, C, D e E aplicadas; `0009`/`0010`/`0011` resolveram `contacts.legacy_id`, `installments.legacy_id`, `agreements.closed_at` e as tabelas de responsavel/contato do aluno), entao a carga roda sem `--allow-proposed`.
- `docs/CANONICAL_LOAD_REPORT.md` traz o relatorio da ultima carga canonica (plano por entidade, linhas carregadas, achados e bloqueios).
- `docs/LEGACY_APP_SOURCE_GAPS.md` compara o Canvas App legado com as planilhas: tabelas e campos que a app le e o workbook nao tem.
- `scripts/profile_legacy_workbook.py`, `scripts/stage_legacy_workbook.py` e `scripts/validate_staging_batch.py` operam em modo somente leitura sobre as fontes e escrevem apenas tabelas de staging.
- `scripts/audit_legacy_app_sources.py` (`npm run db:audit-app-sources`) le a copia descompactada da app, o workbook e a solucao Dataverse e regenera `docs/LEGACY_APP_SOURCE_GAPS.md` sem conectar no banco.
- `scripts/load_canonical_batch.py` executa a fase 7 (`npm run db:load-canonical` e um dry-run; `npm run db:load-canonical-commit` escreve). A carga e idempotente: rodar de novo reutiliza os UUIDs pela chave legada e nao duplica linhas.
- `scripts/legacy_field_map.json` guarda o dicionario e `scripts/build_field_dictionary.py` o resolve e audita contra `apps/api/migrations/*.sql`.

## Estado atual e proximos passos

Fundacao entregue: autenticacao, RBAC, schema canonico, migracao do legado e os primeiros contratos de escrita do dominio.

Situacao em 2026-10-27: autenticacao com rotacao de refresh, RBAC por permissao, trilha em `audit_logs`, os contratos `PATCH` parciais (auditados como `<entidade>.updated`), as rotas de migracao (`/api/v1/migrations`: registro do lote, gate de `validate`/`commit` e triagem de achados, exclusivas do `admin`) e os testes de integracao com PostgreSQL descartavel (`npm run test:integration` com `TEST_DATABASE_URL`) estao implementados. A migracao do legado fechou o dicionario (`0 review`, `0 proposed`) e a carga canonica local rodou completa: `150.018` linhas em `10` entidades, com `agreements.reference` materializado. As rotas de leitura e escrita do dominio de aluno tambem entraram (`/api/v1/students/:studentId/guardians`, `/api/v1/students/:studentId/contacts`, `PATCH /api/v1/guardians/:id` e `PATCH /api/v1/student-contacts/:id`) e o `PATCH /api/v1/agreements/:id` passou a aceitar `closedAt`. Rotas e permissoes em `docs/API_ROUTES.md`.

O que falta: reconciliar o pos-corte no banco local (3 linhas sem `legacy_source`, R$ 1.362,48 de divergencia acordo/parcela, 24 contatos atras do ensaio), os adaptadores ChatGuru e SMTP usando segredos por ambiente e cadastrar o webhook do Asaas numa URL publica (o cliente, os handlers, o webhook e o consumidor de eventos ja estao escritos, testados com fake e com a chave real no `.env` local - ver "Credenciais do Asaas"). O Supabase saiu do caminho critico em 2026-10-27: o canonico oficial e o PostgreSQL local, e migrar para um Postgres gerenciado depois e so trocar `DATABASE_URL`/`DIRECT_DATABASE_URL`/`STAGING_DATABASE_URL`.

A fila de saida do Asaas esta implementada: `docs/OUTBOX_DESIGN.md` descreve a tabela `outbox_events` (migration `0012`), o claim com `FOR UPDATE SKIP LOCKED`, o backoff e a regra de idempotencia/conciliacao, e o worker em processo com a ordem de encerramento correta em `server.ts`. Ja existem `enqueueOutbox` (`apps/api/src/db/outbox.ts`), o laco (`apps/api/src/outbox/worker.ts`, com `runOutboxCycle` e `startOutboxWorker`), o cliente Asaas (`apps/api/src/integrations/asaas-client.ts`, atras da interface `AsaasClient` que os testes substituem por um fake), os handlers dos dois topics, os endpoints `GET /api/v1/ops/outbox` e `POST /api/v1/ops/outbox/:id/retry`, o expurgo horario das linhas `done` (`OUTBOX_RETENTION_DAYS`, migration `0013`) e os dois produtores explicitos (`POST /api/v1/customers/:id/asaas` e `POST /api/v1/installments/:id/charge`, ambos `finance:write`): cobrar e acao deliberada, nunca efeito de criar parcela. O consumidor de `asaas_events` tambem esta implementado (`apps/api/src/outbox/events.ts` + `db/asaas-events.ts` + `domain/asaas-events.ts`, migration `0014`): o webhook grava o payload e responde `202`, e um segundo laco no mesmo processo aplica `installments.status`, `payments` e `asaas_charges.status` conforme `docs/ASAAS_EVENT_RULES.md` (evento -> estado, `stale`, `orphan`, teto de `WEBHOOK_RETRY_LIMIT`), com a operacao em `GET /api/v1/ops/asaas-events` e `POST /api/v1/ops/asaas-events/:id/retry`. A chave e o token do webhook estao configurados no `.env` local (ver "Credenciais do Asaas"). O percentual de retencao passou a ter fonte canonica: `schools.retention_percentage` (migration `0015`, `numeric(5, 4)` com `CHECK 0..1`), aceito no `POST /api/v1/schools` e editavel por `PATCH /api/v1/schools/:id` junto de `retentionEnabled`. Com `RETENTION_LEDGER_ENABLED=true` o consumidor lanca `retention` no evento que confirma dinheiro e `reversal` no estorno, sempre atras da chave; continua aberta a origem do `entry_type='release'` (repasse humano x evento do provedor).

## Credenciais do Asaas

O `.env` da raiz (ignorado pelo git) esta preenchido e foi validado contra o provedor em 2026-10-27:

- **`ASAAS_API_KEY`** - chave de **producao** da conta VOA, a mesma que o Power Apps usava. Ela vive no
  export legado `_legacy-powerapps/projects-and-sources/_import/VOA/TBL_BANCO.csv` (coluna
  `BANCO_APIKEY`, registro unico `Conta VOA Asaas`) e, com o mesmo sha256, em
  `_legacy-powerapps/root-exports/VOA.xlsx` e no backup do workbook. **Nao** existe chave no PostgreSQL
  canonico: varredura de todas as colunas `text/jsonb` por `$aact` devolve zero linhas, e o staging
  grava `[REDACTED]` porque `is_sensitive('BANCO_APIKEY')` e verdadeiro. Verificacao:
  `GET /v3/myAccount/status` responde `200` com `commercialInfo`/`bankAccountInfo`/`documentation`
  `APPROVED` e `GET /v3/customers?limit=1` lista `1472` registros; o host de sandbox recusa a chave
  com `401 invalid_access_token`.
- **Rotacao pendente (nao e opcional antes de producao):** `FIELD_MAPPING_DICTIONARY.md` marca
  `TBL_BANCO.BANCO_APIKEY` como `ignore` com a nota "credencial comprometida: revogar na origem", e
  `LEGACY_DOMAIN_INVENTORY.md` secao 8 repete a conclusao. A chave funciona, mas circulou por planilha e
  export - o certo e gerar outra em Integracoes > Chave de API no painel do Asaas, colar em
  `ASAAS_API_KEY` (nada mais muda) e revogar a antiga. Revogar antes de o fluxo legado do Power
  Automate sair do ar derruba o que ele ainda chama na API, entao a ordem e: publicar este sistema,
  desligar o webhook legado, rotacionar.
- **`ASAAS_ENVIRONMENT=production`** e **`ASAAS_API_URL=https://api.asaas.com/v3`**. O valor anterior
  (`https://sandbox.asaas.com/api/v3`) nao e o host da API v3 atual e nao respondia nada.
  **Efeito colateral:** com esse `.env`, `POST /api/v1/installments/:id/charge` cria cobranca real. Para
  homologar sem dinheiro, troque as tres variaveis pela chave da conta sandbox do Asaas - nada mais no
  codigo muda, porque `ASAAS_ENVIRONMENT` acompanha a linha da fila do inicio ao fim.
- **`ASAAS_WEBHOOK_TOKEN`** - gerado localmente (`secrets.token_urlsafe(32)`); o Asaas reenvia esse valor
  no header `asaas-access-token`, conferido em `apps/api/src/routes/ops.ts`. Sem ele (ou com valor
  diferente) o webhook responde `401`. Os dois webhooks que a conta ja tem - `Cobmais`
  (`webhook.cloud.cobmais.com.br`) e o legado `Webhook para cobranças` (Power Automate) - estao com
  `authToken` vazio, entao nao havia token para reaproveitar e nenhum dos dois foi alterado. Enquanto
  os tres coexistirem, cada evento e entregue mais de uma vez; desligar o do Power Automate e decisao
  de operacao.

Registrar o webhook deste projeto exige uma URL publica (tunel ou VPS), porque `localhost` nao recebe
callback:

```bash
curl -s https://api.asaas.com/v3/webhooks \
  -H "access_token: $ASAAS_API_KEY" -H 'Content-Type: application/json' \
  -d "{\"name\":\"VOA Financeiro\",\"url\":\"https://SEU-HOST/api/v1/webhooks/asaas\",
       \"enabled\":true,\"interrupted\":false,\"apiVersion\":3,
       \"authToken\":\"$ASAAS_WEBHOOK_TOKEN\",
       \"events\":[\"PAYMENT_CREATED\",\"PAYMENT_CONFIRMED\",\"PAYMENT_RECEIVED\",\"PAYMENT_REFUNDED\",
                   \"PAYMENT_PARTIALLY_REFUNDED\",\"PAYMENT_RECEIVED_IN_CASH_UNDONE\"]}"
```

Validacao local rapida (sem rede): `node dist/server.js` e
`curl -X POST localhost:3000/api/v1/webhooks/asaas` responde `401`; com
`-H "asaas-access-token: $ASAAS_WEBHOOK_TOKEN"` e um JSON com `id`/`event` responde `202` e o evento
aparece em `GET /api/v1/ops/asaas-events` como `orphan` (o `payment.id` nao existe no banco).
