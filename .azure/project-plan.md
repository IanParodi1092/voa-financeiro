# VOA Financeiro Web

**Status**: Approved
**Created**: 2026-09-24
**Mode**: Guided

## 1. Objetivo

Construir uma aplicacao web financeira para substituir gradualmente o Canvas App VOA/Compras, preservando os dados atuais e reduzindo a dependencia operacional do Power Apps/Dataverse. O MVP deve centralizar clientes, escolas, alunos, acordos, parcelas, pagamentos, cobrancas e auditoria em PostgreSQL no Supabase, com API propria em TypeScript/Fastify e frontend React.

Decisoes adotadas: TypeScript no backend e frontend, Fastify, React, PostgreSQL no Supabase, autenticacao obrigatoria, Hostinger para e-mail e futura hospedagem VPS/app, Asaas em producao como integracao oficial com sandbox para testes e ChatGuru somente por backend/webhooks.

## 2. Escopo MVP

Incluido:

- Login, sessao, usuarios, papeis e permissoes.
- Cadastro e consulta de escolas, clientes/responsaveis, alunos e contatos.
- Cadastro e acompanhamento de acordos, parcelas, pagamentos e status de cobranca.
- Calculo de retencao por escola: meta, total retido, valor retido e valor liberado, com limite de 50% por parcela ate atingir a meta.
- Criacao e consulta de clientes e cobrancas no Asaas, com idempotencia e sincronizacao de status.
- Registro de eventos de webhook Asaas e ChatGuru, incluindo reprocessamento seguro.
- Comunicacoes transacionais por e-mail Hostinger e solicitacoes de mensagem ao ChatGuru.
- Filtros, listagens operacionais, exportacao controlada e trilha de auditoria.
- Importacao inicial a partir de Dataverse/Excel/XML/CSV preservando chaves legadas e evidencias.

Fora do MVP: reescrita imediata de todas as telas do Canvas, automacoes nao documentadas, dashboard analitico avancado, conciliacao bancaria automatica, app mobile nativo e exclusao fisica de dados legados.

## 3. Arquitetura

Monorepo Node.js com dois aplicativos: `apps/api` para a API Fastify e `apps/web` para a SPA React. O frontend nunca acessa Asaas, ChatGuru ou o banco diretamente; toda regra financeira e integracao externa passa pela API.

Fluxo principal: navegador -> frontend React -> API Fastify -> PostgreSQL/Supabase. A API usa adaptadores para Asaas, ChatGuru e SMTP Hostinger. Webhooks externos chegam na API, sao autenticados, persistidos em uma tabela de eventos e processados de forma assincrona/idempotente. Jobs de retry e sincronizacao devem poder rodar no mesmo processo inicialmente e ser extraidos para worker no VPS quando a carga exigir.

Componentes:

- API: rotas versionadas `/api/v1`, validacao de schemas, servicos de dominio, repositorios, logs estruturados e tratamento global de erros.
- Frontend: shell autenticado, modulos por dominio, tabelas com filtros, formularios com validacao e estados de loading/erro/vazio.
- Banco: PostgreSQL gerenciado pelo Supabase, migrations versionadas e politicas de acesso; a API usa credencial server-side.
- Arquivos: manter fontes originais no workspace/backup durante migracao; anexos novos devem usar armazenamento de objetos definido em fase posterior, sem gravar binarios no banco.

## 4. Modulos de Dominio

- Identidade e acesso: usuarios, papeis, permissoes, sessoes e auditoria.
- Cadastro: escolas, clientes, responsaveis, alunos, contatos e enderecos.
- Financeiro: contas, categorias, empresas, centros de custo, acordos, parcelas, pagamentos e extratos.
- Retencao: configuracao por escola, acumulado, calculo deterministico e historico de alteracoes.
- Cobranca: clientes Asaas, cobrancas, links/boleto/Pix, eventos e reconciliacao.
- Comunicacao: templates, fila de mensagens, envio de e-mail, ChatGuru e resultado de entrega.
- Migracao: lotes, mapeamentos, erros, duplicidades, checkpoints e relatorios de reconciliacao.
- Auditoria: quem fez, quando, origem, entidade, identificador, acao, antes/depois e correlation id.

## 5. Entidades e Relacionamentos PostgreSQL

Todas as tabelas devem ter `id` UUID, `created_at`, `updated_at` e, quando aplicavel, `deleted_at` para soft delete. Manter `legacy_source`, `legacy_table` e `legacy_id` unicos por origem para impedir duplicacoes.

- `users`, `roles`, `permissions`, `user_roles`, `role_permissions`: usuario autenticado e autorizacao RBAC.
- `schools`: escola, status, configuracao de retencao (`retention_enabled`, `retention_target_amount`). Uma escola possui muitos alunos, acordos e pagamentos.
- `customers`, `contacts`, `addresses`: cliente/responsavel e seus meios de contato. Um cliente pode estar relacionado a varios alunos e acordos.
- `students`: aluno, escola, cliente/responsavel e identificadores legados.
- `companies`, `suppliers_customers`, `accounts`, `cost_centers`, `payment_categories`: cadastros mestres financeiros.
- `agreements`: acordo de um cliente/escola, valor, quantidade de parcelas e estado. Um acordo possui muitas `installments`.
- `installments`: parcela, vencimento, valor original, estado e referencia ao acordo. Uma parcela pode ter cobranca e pagamentos relacionados.
- `payments`: pagamento recebido, valor original, valor retido, valor liberado, data, origem, status e referencias de conciliacao.
- `retention_ledger`: lancamentos imutaveis de retencao por escola/parcela, permitindo recalculo e auditoria sem depender de soma mutavel.
- `asaas_customers`, `asaas_charges`, `asaas_events`: mapeamento dos IDs externos, payload normalizado, status, ambiente e eventos idempotentes. `asaas_charges` referencia cliente, acordo/parcela e opcionalmente pagamento.
- `message_templates`, `message_deliveries`, `chatguru_events`, `email_deliveries`: comunicacoes, tentativas, status e callbacks.
- `migration_batches`, `migration_rows`, `migration_errors`, `reconciliation_reports`: controle de importacao, chave de origem, hash da linha, erro e contagens.
- `audit_logs`, `outbox_events`, `webhook_events`: trilha de auditoria, eventos a publicar e recebimentos externos.

Relacionamentos essenciais: `schools 1:N students`, `customers 1:N students`, `customers 1:N agreements`, `schools 1:N agreements`, `agreements 1:N installments`, `installments 1:N payments`, `schools 1:N retention_ledger`, `installments 1:N asaas_charges`, `asaas_customers 1:N asaas_charges`. Indices devem cobrir CPF/documento normalizado, e-mail, identificadores legados, vencimento/status e chaves externas Asaas.

### 5.1 Regras canonicas apos auditoria do legado

O legado foi auditado em `voa-financeiro-web/docs/LEGACY_DOMAIN_INVENTORY.md` e as regras de identidade estao em `voa-financeiro-web/docs/CANONICAL_DATA_RULES.md`. A implementacao nova deve manter UUID interno separado de ID legado e ID externo Asaas. CPF/CNPJ, matricula/documento e IDs externos terao unicidade forte; nomes normalizados serao usados para busca e alerta de duplicidade, com revisao assistida antes de qualquer merge.

Novas telas de dominio devem aguardar a validacao do dicionario e do plano de migracao. A UI atual e somente um shell operacional de autenticacao/cadastro e nao representa ainda a UI final do produto.

## 6. Design System & UI

**Component Library**: Fluent UI v9
**Frontend**: React + TypeScript em SPA administrativa responsiva.
**Navegacao**: menu autenticado por dominio: Visao geral, Cadastros, Acordos, Parcelas/Pagamentos, Cobrancas, Comunicacoes, Migracao e Auditoria.
**Padrao visual**: interface operacional densa, tabelas escaneaveis, formularios com validacao inline, estados vazios/erro/loading e confirmacao explicita para operacoes destrutivas.
**Telas MVP**: login; dashboard operacional; listagem/detalhe de escolas; clientes/alunos; acordos e parcelas; pagamento com painel de retencao; cobrancas Asaas; fila de comunicacoes; importacao e reconciliacao; auditoria.

## 7. Endpoints Iniciais

Base `/api/v1`:

- `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`.
- `GET/POST /schools`, `GET/PATCH /schools/:id`, `GET/POST /customers`, `GET/PATCH /customers/:id`.
- `GET/POST /students`, `GET/PATCH /students/:id`, `GET/POST /agreements`, `GET/PATCH /agreements/:id`.
- `GET/POST /installments`, `GET/PATCH /installments/:id`, `GET/POST /payments`, `GET/PATCH /payments/:id`.
- `GET /schools/:id/retention`, `POST /schools/:id/retention/recalculate`.
- `POST /billing/asaas/customers`, `POST /billing/asaas/charges`, `GET /billing/asaas/charges/:id`, `POST /webhooks/asaas`.
- `POST /communications/email`, `POST /communications/chatguru`, `POST /webhooks/chatguru`.
- `POST /migrations/batches`, `POST /migrations/batches/:id/validate`, `POST /migrations/batches/:id/commit`, `GET /migrations/batches/:id/reconciliation`.
- `GET /audit-logs` e endpoints de consulta para relatorios operacionais.

Todos os endpoints de escrita devem aceitar `Idempotency-Key` quando houver efeito externo ou financeiro. Respostas de erro seguem um contrato unico com codigo, mensagem segura, detalhes de validacao e correlation id. OpenAPI sera mantido junto das rotas.

## 8. Autenticacao e Autorizacao

Autenticacao obrigatoria com access token curto e refresh token revogavel, cookies seguros para a SPA quando hospedada no mesmo dominio e protecao contra CSRF conforme o mecanismo adotado. Senhas devem usar hash forte, nunca serem registradas em logs e exigir politica minima. Aplicar rate limit em login e webhooks.

RBAC inicial: `admin`, `financeiro`, `operacao`, `comunicacao`, `auditor` e `leitura`. Autorizar por acao e dominio no backend, nao apenas ocultando botoes no frontend. Operacoes de pagamento, retencao, importacao, exclusao logica e reprocessamento exigem permissao explicita e auditoria. Segredos ficam somente em variaveis de ambiente ou secret manager; nunca em `.env` versionado, export do Power Apps ou payload de log.

## 9. Integracoes Externas

**Asaas**: producao e o ambiente oficial; sandbox fica restrito a testes automatizados e homologacao. Criar cliente antes da cobranca quando necessario, armazenar apenas IDs/status/metadados necessarios, usar chave por ambiente, timeout, retry com backoff e idempotencia. Webhook deve validar assinatura/token, persistir payload bruto redigido, deduplicar por event id, atualizar cobranca/parcela e registrar falhas para retry. Nunca promover dados de sandbox para producao sem mapeamento explicito.

**ChatGuru**: integracao exclusivamente pelo backend/webhooks. O servico de comunicacao grava uma entrega antes do envio, envia usando template e chave de idempotencia, registra resposta e processa callbacks. Nao expor token no browser e nao disparar mensagens sem consentimento/regra de contato e telefone validado.

**Hostinger**: SMTP/e-mail transacional com remetente configurado por ambiente, TLS, timeout, fila, retry e registro de entrega. A hospedagem futura pode ser uma VPS Hostinger com reverse proxy, processo Node gerenciado e backups; o Supabase permanece separado como banco gerenciado.

## 10. Migracao e Preservacao de Dados

Fazer inventario e snapshot somente leitura das fontes: `Compras/build_src`, `Microsoft.PowerApps/src`, export Dataverse, `VOA.xlsx`, XML/CSV, scripts `_import` e artefatos `_debug`. Manter os arquivos originais intactos e registrar hash, data e origem do lote.

Pipeline: extrair -> normalizar nomes/tipos -> validar chaves e referencias -> carregar tabelas mestres -> carregar clientes/escolas/alunos -> acordos/parcelas/pagamentos -> IDs externos Asaas -> reconciliar contagens/valores -> liberar leitura no MVP. Cada linha deve conservar `legacy_source`, `legacy_table`, `legacy_id` e hash de conteudo.

Executar primeiro em staging, em lotes repetiveis e com checkpoint. Duplicidades devem ser agrupadas por chave de negocio e revisadas; nunca resolver por exclusao automatica. Comparar contagem por entidade, totais financeiros, datas, status, amostras e relacionamentos. O cutover deve ter janela, export final, congelamento controlado, delta final, plano de rollback e periodo de operacao paralela.

## 11. Limpeza Segura

Nao apagar arquivos, registros Dataverse, Excel, XML, backups ou artefatos legados durante o MVP. A limpeza futura somente pode ocorrer apos aprovacao, backup verificavel, relatorio de reconciliacao sem divergencias bloqueantes, retencao legal definida e teste de restauracao. Preferir arquivamento e soft delete; remover duplicata apenas com identificador, motivo, aprovacao, log e possibilidade de restauracao. Segredos expostos em artefatos devem ser revogados e substituidos, sem reescrever historico de dados.

## 12. Testes e Qualidade

- Unitarios para calculo de retencao, arredondamento monetario, transicoes de status, idempotencia e normalizacao de chaves.
- Integracao com PostgreSQL/Supabase para constraints, migrations, RBAC, transacoes e reconciliacao.
- Contrato/OpenAPI para endpoints e schemas.
- Webhook tests para Asaas e ChatGuru: assinatura, duplicata, ordem fora de sequencia, retry e payload invalido.
- Sandbox Asaas para criacao de cliente/cobranca e simulacao de eventos; mocks deterministas para CI.
- E2E do fluxo login -> cadastro -> acordo -> parcela -> cobranca -> webhook -> pagamento -> retencao.
- Migracao em amostra representativa e dry-run completo antes do commit; comparar totais e detectar duplicidades.
- Seguranca: validacao de entrada, autorizacao negativa, rate limit, secrets scan, dependencias e logs sem PII desnecessaria.
- Smoke test pos-deploy, health/readiness checks e monitoramento de erros, filas e webhooks pendentes.

## 13. Deploy e Operacao Hostinger/VPS

Empacotar API e frontend em builds reproduziveis. No inicio, frontend pode ser servido como estatico por Nginx e API como processo Node.js em VPS Hostinger, atras de HTTPS/reverse proxy. Configurar dominio/subdominio, certificados, firewall, usuario sem privilegio, processo supervisionado (systemd ou PM2), logs rotacionados, backups e health checks. Supabase nao deve ser exposto com credenciais administrativas ao frontend.

Pipeline por ambientes: local -> staging -> producao. Cada ambiente tem banco, chaves Asaas, webhooks, SMTP e ChatGuru separados. Deploy deve rodar migrations transacionais, smoke tests e permitir rollback para a versao anterior; mudancas destrutivas de schema exigem expand/contract e janela aprovada.

## 14. Variaveis de Ambiente

Obrigatorias por ambiente, documentadas em `.env.example` sem valores reais:

- `NODE_ENV`, `PORT`, `APP_BASE_URL`, `CORS_ORIGINS`, `LOG_LEVEL`.
- `DATABASE_URL`, `DIRECT_DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` quando aplicavel ao frontend, e `SUPABASE_SERVICE_ROLE_KEY` somente na API.
- `AUTH_JWT_SECRET` ou segredo equivalente, `AUTH_REFRESH_SECRET`, `COOKIE_DOMAIN`, `COOKIE_SECURE`.
- `ASAAS_ENVIRONMENT`, `ASAAS_API_URL`, `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`.
- `CHATGURU_BASE_URL`, `CHATGURU_API_TOKEN`, `CHATGURU_WEBHOOK_SECRET`.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` para Hostinger.
- `MIGRATION_SOURCE_DIR`, `MIGRATION_BATCH_SIZE`, `WEBHOOK_RETRY_LIMIT`, `RATE_LIMIT_MAX`.

Validar variaveis na inicializacao, falhar com mensagem segura quando ausentes e nunca imprimir valores secretos.

## 15. Fases de Execucao

1. **Fundacao**: confirmar monorepo, Fastify/React/TypeScript, lint/test/build, config de ambiente, logging, health check e migration runner.
2. **Auditoria de legado e dicionario**: ler telas, formulas, fluxos, metadados Dataverse e workbooks; mapear campos, cardinalidades, chaves, duplicidades e regras antes de expandir a UI.
3. **Identidade e cadastros**: schema base, autenticacao, RBAC, escolas, clientes, alunos, contatos e auditoria.
4. **Financeiro MVP**: acordos, parcelas, pagamentos, mestres financeiros, retencao e telas operacionais.
5. **Asaas**: adaptador, clientes/cobrancas, webhooks, idempotencia, sandbox e testes de contrato.
6. **Comunicacoes**: e-mail Hostinger, ChatGuru, templates, fila, callbacks e consentimento.
7. **Migracao**: staging, importadores, mapeamentos, deduplicacao assistida, reconciliacao e carga incremental sem apagar fontes.
8. **Homologacao e cutover**: E2E, seguranca, desempenho, treinamento, operacao paralela, delta final e rollback ensaiado.
9. **Producao Hostinger/VPS**: infraestrutura, dominio/HTTPS, observabilidade, backup, deploy automatizado e suporte pos-cutover.
10. **Evolucao**: relatorios, conciliacao bancaria, anexos, workers separados e desativacao gradual de telas do Canvas somente apos aceite operacional.

## 16. Criterios de Aceite

O MVP sera aceito quando usuarios autenticados conseguirem operar o ciclo cadastro -> acordo -> parcela -> cobranca -> pagamento com regras de permissao, retencao auditavel e sincronizacao Asaas; webhooks duplicados nao criarem efeitos duplicados; ChatGuru/e-mail registrarem tentativas; migracao reproduzir contagens e totais definidos; testes automatizados e smoke tests passarem; e houver rollback, backup e runbook de operacao sem remover nenhuma fonte legada.