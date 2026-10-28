# Regras de entrada do Asaas (`asaas_events`)

Regra escrita **antes** do codigo (decisao de 2026-10-27), a pedido da operacao: a fila de saida ja
esta fechada (`docs/OUTBOX_DESIGN.md`), e o outro lado do ciclo - o evento do provedor virando estado
local - mexe em dinheiro e merece tabela combinada antes da primeira linha de codigo.

Escopo: o consumidor `apps/api/src/outbox/events.ts` (passo 8 da secao 14 do desenho). O webhook
(`apps/api/src/routes/ops.ts`) ja grava o evento cru em `asaas_events` com `external_event_id UNIQUE`
e responde `202`; nada aqui muda aquela rota.

## 1. O que o provedor garante (e o que nao garante)

| Fato | Consequencia para nos | Fonte |
|---|---|---|
| Entrega **at least once**: o mesmo evento pode chegar mais de uma vez com o mesmo `id` | `external_event_id UNIQUE` + "handler aplica estado, nunca incrementa" sao obrigatorios | [Webhook Events](https://docs.asaas.com/docs/webhooks-events), [Send types](https://docs.asaas.com/docs/send-types) |
| `sendType = NON_SEQUENTIALLY` **nao garante ordem**; `SEQUENTIALLY` garante, mas um evento lento atrasa os seguintes | Nao depender de ordem: cada evento e um **estado alvo** com origem permitida; fora disso e `stale` | [Send types](https://docs.asaas.com/docs/send-types) |
| Falha de entrega tem retry; **15 falhas consecutivas** podem pausar a fila e o provedor guarda eventos por **14 dias** | O endpoint responde rapido (so grava) e o consumidor precisa drenar em horas, nao em dias | [Introduction - Webhooks](https://docs.asaas.com/docs/about-webhooks) |
| O payload traz `id` (evento), `event` e o recurso (`payment` com `id`, `status`, `value`, `netValue`, `billingType`, `externalReference`) | O consumidor **nao** faz chamada extra ao provedor para aplicar estado | [Payment events](https://docs.asaas.com/docs/payment-events) |
| Os nomes dos eventos sao fechados pelo provedor (`PAYMENT_*`) | Evento desconhecido nunca derruba a fila: vira `ignored` e aparece no relatorio | idem |

Decisao: configurar o webhook como **`NON_SEQUENTIALLY`** (mais throughput) e absorver a falta de ordem
no consumidor, em vez de pagar latencia em cadeia com `SEQUENTIALLY`. Se a operacao preferir ordem
garantida, a regra continua correta - so deixa de ser exercitada.

## 2. Vocabulario local (fechado)

`installments.status` e `text` livre no schema. A partir daqui o consumidor so escreve estes valores:

| Valor | Significado | Quem escreve |
|---|---|---|
| `pending` | sem pagamento (default do schema) | criacao da parcela, `PAYMENT_RESTORED` |
| `overdue` | venceu sem pagamento | `PAYMENT_OVERDUE` |
| `paid` | pago (confirmado ou recebido) | `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_RECEIVED_IN_CASH` |
| `refunded` | devolvido integralmente | `PAYMENT_REFUNDED` |
| `chargeback` | contestado pelo portador | `PAYMENT_CHARGEBACK_*` |
| `canceled` | cobranca removida no provedor | `PAYMENT_DELETED` |

`payments.status` (tambem `text` livre; a API ja grava `paid` no lancamento manual):

| Valor | Significado |
|---|---|
| `confirmed` | `PAYMENT_CONFIRMED` - pago, saldo ainda nao disponivel |
| `paid` | `PAYMENT_RECEIVED` / `PAYMENT_RECEIVED_IN_CASH` - recebido |
| `partially_refunded` | `PAYMENT_PARTIALLY_REFUNDED` |
| `refunded` | `PAYMENT_REFUNDED` |

`payments` continua sendo **um lancamento por cobranca do provedor**: `source = 'asaas'`,
`external_id = payment.id`, `amount = payment.value`, `paid_at` do payload. Reaplicar o mesmo evento
faz `ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO UPDATE`, nunca um segundo
lancamento - e essa chave ja existe desde a `0004` (`payments_external_idx`), nao precisa de indice
novo. `amount <= 0` nao vira lancamento (`CHECK (amount > 0)`): a parcela e atualizada e o motivo vai
para o log e o `audit_logs`.

## 3. Tabela evento -> estado

`Origem aceita` e o que separa `applied` de `stale`: um evento cujo estado atual da parcela nao esta
na lista e **no-op com `processed_at`** e log `asaas.event.stale`. Sem isso, um `PAYMENT_RECEIVED`
atrasado reabriria uma parcela ja estornada.

| Evento | `installments.status` | `payments.status` | Origem aceita | Observacao |
|---|---|---|---|---|
| `PAYMENT_CONFIRMED` | `paid` | `confirmed` | `pending`, `overdue`, `chargeback` | saldo ainda nao disponivel; `chargeback` vencido volta a `paid` |
| `PAYMENT_RECEIVED` | `paid` | `paid` | `pending`, `overdue`, `paid`, `chargeback` | sobe `confirmed` -> `paid` |
| `PAYMENT_RECEIVED_IN_CASH` | `paid` | `paid` | `pending`, `overdue` | `billingType = RECEIVED_IN_CASH` |
| `PAYMENT_OVERDUE` | `overdue` | - | `pending`, `overdue` | nunca cria `payments` |
| `PAYMENT_DELETED` | `canceled` | - | `pending`, `overdue` | provedor nao remove cobranca paga |
| `PAYMENT_RESTORED` | `pending` | - | `canceled` | desfaz o `DELETED` |
| `PAYMENT_REFUNDED` | `refunded` | `refunded` | `paid` | estorno total |
| `PAYMENT_PARTIALLY_REFUNDED` | `paid` (mantem) | `partially_refunded` | `paid` | valor estornado fica no payload |
| `PAYMENT_CHARGEBACK_REQUESTED`, `PAYMENT_CHARGEBACK_DISPUTE`, `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` | `chargeback` | - | `paid`, `refunded` | dinheiro pode voltar; estado explicito |
| `PAYMENT_CREATED`, `PAYMENT_UPDATED`, `PAYMENT_ANTICIPATED`, `PAYMENT_AUTHORIZED`, `PAYMENT_AWAITING_RISK_ANALYSIS`, `PAYMENT_APPROVED_BY_RISK_ANALYSIS`, `PAYMENT_REPROVED_BY_RISK_ANALYSIS`, `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`, `PAYMENT_REFUND_IN_PROGRESS`, `PAYMENT_REFUND_DENIED`, `PAYMENT_RECEIVED_IN_CASH_UNDONE`, `PAYMENT_BANK_SLIP_VIEWED`, `PAYMENT_CHECKOUT_VIEWED`, `PAYMENT_DUNNING_*`, `PAYMENT_SPLIT_*` | - | - | - | `ignored`: atualiza `asaas_charges.status` quando o payload traz status e registra o evento |

Regras transversais:

1. **`asaas_charges.status` acompanha o payload** em todo evento que traga `payment.status`
   (`PENDING`, `CONFIRMED`, `RECEIVED`, `OVERDUE`, `REFUNDED`, `DELETED`, `CHARGEBACK_*`). E o que
   `GET /installments` e a conciliacao leem.
2. **Nada incrementa.** `payments.amount` e o valor do pagamento, nao um acumulador;
   `retention_ledger` so entra uma vez por `(payment_id, entry_type)`.
3. **Evento orfao** (cobranca nao esta em `asaas_charges`): `processed_at` preenchido,
   `failure_reason = 'charge not found'` e log `asaas.event.orphan`. Nao retenta: cobranca criada por
   fora do fluxo nao vai aparecer por insistencia.
4. **Evento duplicado** nunca chega ao handler (o `UNIQUE` do webhook ja barrou); se chegar por
   reprocessamento manual, o `ON CONFLICT` e o grafo de origem absorvem.
5. **Toda transicao vai para `audit_logs`** como `installment.status_changed` (ou
   `payment.updated`), com `from`, `to`, `event` e `externalEventId` - mesmo padrao de `outbox.done`.

## 4. Desfechos do handler

| Desfecho | `processed_at` | `failure_reason` | Log |
|---|---|---|---|
| `applied` (estado mudou) | agora | `NULL` | `info` `asaas.event.applied` |
| `stale` (origem nao permite) | agora | `NULL` | `info` `asaas.event.stale` |
| `ignored` (evento fora do mapa) | agora | `NULL` | `debug` `asaas.event.ignored` |
| `orphan` (cobranca desconhecida) | agora | `charge not found` | `warn` `asaas.event.orphan` |
| falha transitoria (banco fora, deadlock) | nao | incrementa `attempts` | `warn` `asaas.event.retry` |
| falha definitiva **ou** teto de tentativas | nao | `failed_at` + motivo | `error` `asaas.event.dead` |

O teto e `WEBHOOK_RETRY_LIMIT` (`apps/api/src/config.ts`, default 5) - hoje declarado e **sem
consumidor**. No teto o evento vira `failed_at` e sai do claim; a recuperacao e manual, no mesmo
espirito de `POST /ops/outbox/:id/retry`.

## 5. Retencao (`retention_ledger`)

O ledger e o que a rota `GET /schools/:schoolId/retention` soma como `retainedAmount`. Regra proposta:

1. **Quando entra**: no evento que confirma dinheiro (`PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`,
   `PAYMENT_RECEIVED_IN_CASH`), **nunca** em `overdue`/`created`/`updated`.
2. **Quanto**: `round(payment.value * percentual, 2)`. O percentual e da **escola**
   (`schools.retention_percentage`, `numeric(5, 4)` com `CHECK 0..1`, migration `0015`), editavel por
   `PATCH /api/v1/schools/:id`. `payments.retention_percentage` (`0008`) continua sendo o override por
   parcela do fluxo legado (planilha `Pagamento_Lista`): o consumidor grava nele o percentual que
   **efetivamente usou**, para a linha do pagamento se explicar sozinha.
3. **`entry_type`**: `retention` na entrada; `release` quando o repasse sai; `reversal` quando o
   pagamento e estornado depois de a retencao ter sido lancada. `retainedAmount` na rota e **liquido**:
   `retention` soma, `release` e `reversal` subtraem (antes a rota somava tudo, e um estorno
   *aumentava* o retido); `retentionAmount`/`releasedAmount`/`reversedAmount` vao junto. O mesmo
   liquido vale para `payments.retained_amount`: recebe o valor lancado e volta a `0` no `reversal`.
   Estorno **parcial** fica fora da v1: o ledger nao rateia, e `PAYMENT_PARTIALLY_REFUNDED` so muda o
   estado do pagamento.
4. **Escola sem retencao** (`schools.retention_enabled = false`) ou percentual nulo: **nenhum
   lancamento**, e `payments.retention_status = 'not_applicable'` - so quando ele ainda esta nulo, porque
   `pending_approval`/`approved`/`released` e ciclo de aprovacao humana (`PATCH /payments/:id`) e o
   consumidor nao o sobrescreve. Percentual `0` tambem nao lanca. Nao inventar percentual.
5. **Idempotencia** (secao 15, item 4 do desenho): indice unico parcial em
   `retention_ledger (payment_id, entry_type) WHERE payment_id IS NOT NULL` (`0014`) **e** `SELECT ... WHERE
   NOT EXISTS` no handler. O indice e a trava; o `NOT EXISTS` mantem o codigo correto num banco que
   ainda nao aplicou a `0014`, e o `ON CONFLICT DO NOTHING` (sem alvo, entao sem depender da inferencia
   do indice parcial) absorve a corrida entre dois processos. Tudo absoluto, nunca incremental:
   reaplicar o evento reescreve o mesmo numero.

> **Resolvido em 2026-10-27: opcao 1.** A fonte do percentual para pagamento novo e a **escola**:
> `schools.retention_percentage numeric(5, 4)` (`CHECK 0..1`, migration `0015`), aceito no
> `POST /api/v1/schools` e editavel por `PATCH /api/v1/schools/:id` com `retentionEnabled`
> (`catalog:write`). `NULL` = escola sem percentual; `retention_enabled` = interruptor, e os dois
> precisam estar preenchidos/ligados. As alternativas ficam registradas e descartadas: manter so
> `payments.retention_percentage` (opcao 2) depende de alguem preencher antes da baixa e a cobranca pode
> ser paga antes, e `retention_target_amount` (opcao 3) e meta total, nao fracao.
>
> O lancamento continua atras de `RETENTION_LEDGER_ENABLED` (**default `false`**): a coluna existe e pode
> ser preenchida, mas o ledger so recebe linha quando a chave for ligada por ambiente, depois de as
> escolas estarem configuradas. Ligado, a regra 4 aparece no log como `asaas.event.retention_skipped`
> (`debug`) e no `audit_logs` do evento.
>
> Continua aberto: a **origem do `release`** (repasse humano x evento do provedor) e o
> `PAYMENT_RECEIVED_IN_CASH_UNDONE` (secao 9).

## 6. O que falta no schema (`0014_asaas_events_consumer.sql`)

O desenho da secao 9 fala em "teto de tentativas", mas `asaas_events` **nao tem contador** - hoje so
existem `processed_at`, `failed_at` e `failure_reason`. Sem coluna, o consumidor nao distingue "nunca
tentou" de "tentou 5 vezes".

| Mudanca | Motivo | Risco |
|---|---|---|
| `asaas_events.attempts int NOT NULL DEFAULT 0` | teto do `WEBHOOK_RETRY_LIMIT` por evento | nenhum (default cobre as linhas existentes) |
| `asaas_events.last_attempt_at timestamptz` | separar "preso" de "esperando", igual a `locked_at` do outbox | nenhum |
| `UNIQUE` parcial `payments (external_id) WHERE source = 'asaas' AND external_id IS NOT NULL` | ~~o `ON CONFLICT (external_id)` do consumidor exige a chave~~ **descartado**: `payments_external_idx` (`UNIQUE (source, external_id) WHERE external_id IS NOT NULL`, `0004`) ja existe, e o `ON CONFLICT` do consumidor usa essa chave. Um indice parcial em `(external_id)` seria redundante e quebraria a inferencia (o predicado dado nao implica `external_id IS NOT NULL`) | nenhum - nao entrou na `0014` |
| `UNIQUE` parcial `retention_ledger (payment_id, entry_type) WHERE payment_id IS NOT NULL` | trava do item 4 | idem: `SELECT payment_id, entry_type, count(*) ... GROUP BY 1,2 HAVING count(*) > 1` |
| `schools.retention_percentage numeric(5,4) CHECK (0..1)` + `PATCH /schools/:id` | fonte canonica do percentual para pagamento novo (secao 5) | **feito** na `0015`, sem backfill (a coluna nasce `NULL` e `RETENTION_LEDGER_ENABLED` continua `false`) |

Pre-flight sugerido (`SELECT` unico, somente leitura) antes da `0014`:

```sql
SELECT 'payments' AS tabela, count(*) AS duplicados FROM (
  SELECT external_id FROM payments
   WHERE source = 'asaas' AND external_id IS NOT NULL
   GROUP BY 1 HAVING count(*) > 1
) d
UNION ALL
SELECT 'retention_ledger', count(*) FROM (
  SELECT payment_id, entry_type FROM retention_ledger
   WHERE payment_id IS NOT NULL
   GROUP BY 1, 2 HAVING count(*) > 1
) d;
```

Rodado em `voa_staging` em 2026-10-27: **0 duplicados** em `retention_ledger`, `payments` com
`source = 'asaas'` ainda em `0` linhas (a carga legada usa outra fonte) e `asaas_events` vazia. O
indice do ledger entra sem backfill nem correcao de dado; `payments` dispensa indice novo pela
`payments_external_idx`.

## 7. Operacao

Mesmo padrao do outbox, com nomes proprios:

- `GET /api/v1/ops/asaas-events` (`read`) - `counts` por desfecho (`pending`, `processed`, `failed`),
  `oldestPendingAgeSeconds` e as 10 linhas `failed` mais recentes (`id`, `eventType`,
  `externalChargeId`, `attempts`, `failureReason`, `createdAt`). Pendente com mais de 10 minutos
  significa consumidor parado (o provedor pausa a fila depois de 15 falhas e apaga em 14 dias);
- `POST /api/v1/ops/asaas-events/:id/retry` (`audit`) - limpa `failed_at`/`failure_reason`, zera
  `attempts`; so aceita linha `failed_at IS NOT NULL`, respondendo `409 ASAAS_EVENT_NOT_FAILED` no
  resto. Mesma trava contra entrega concorrente do `outbox`;
- log de cada evento aplicado: `{ eventId, eventType, externalChargeId, outcome, from, to, durationMs }`;
- o teto de 15 falhas do **provedor** olha o nosso HTTP; como o webhook responde `202` logo depois do
  `INSERT`, quem falha e o consumidor - e o alarme e `oldestPendingAgeSeconds`, nao a fila do Asaas.

## 8. Plano de testes

**Unitarios** (`domain/asaas-events.ts` + `.test.ts`, sem banco): a tabela da secao 3 vira uma funcao
pura `resolveTransition(event, currentStatus)` com o mapa `evento -> { para, origens, paymentStatus }`.

- cada evento mapeado devolve o destino certo e as origens declaradas;
- `PAYMENT_RECEIVED` sobre `refunded` -> `stale`; sobre `paid` -> `applied` (so o `payments.status`
  sobe `confirmed` -> `paid`);
- `PAYMENT_DELETED` sobre `paid` -> `stale` (o provedor nao remove cobranca paga);
- evento fora do mapa -> `ignored`, nunca `dead`;
- payload sem `payment.id` -> erro de payload (vira `failed` na primeira tentativa, como
  `OutboxPayloadError` no outbox).

**Integracao** (`outbox/events.integration.test.ts`, mesmo harness e fake de provedor do outbox - aqui
o fake nem e usado, o evento ja chega completo):

1. `PAYMENT_CONFIRMED` -> `installments.status = 'paid'`, `payments` com `status='confirmed'`,
   `source='asaas'`, `external_id` do payload, `asaas_charges.status='CONFIRMED'`, `processed_at`
   preenchido e `audit_logs` com `installment.status_changed`;
2. `PAYMENT_RECEIVED` depois de `CONFIRMED` -> mesmo `payments` (uma linha), `status='paid'`;
3. `PAYMENT_RECEIVED` **antes** de `CONFIRMED` (ordem invertida) -> aplica e o `CONFIRMED` seguinte
   vira `stale`;
4. `PAYMENT_OVERDUE` -> `overdue` e **sem** linha em `payments`;
5. `PAYMENT_REFUNDED` -> `refunded` no `payments` e na parcela; `PAYMENT_RECEIVED` atrasado depois
   disso -> `stale` e estado intacto;
6. `PAYMENT_DELETED` + `PAYMENT_RESTORED` -> `canceled` e volta para `pending`;
7. evento de cobranca desconhecida -> `processed_at` + `failure_reason`, log `orphan`, sem retry;
8. falha de banco simulada (`DROP`/`REVOKE` no schema temporario) -> `attempts` incrementa e o evento
   continua elegivel; na quinta, `failed_at` + motivo;
9. `GET /ops/asaas-events` (401 sem token, `read` para viewer) e `POST .../:id/retry`
   (`audit`, 409 para evento nao falho, 404 para id inexistente, 400 para id invalido);
10. retencao com `RETENTION_LEDGER_ENABLED=true` e percentual configurado na escola -> uma linha
    `entry_type='retention'` com `round(value * pct, 2)`, `payments.retained_amount` e
    `retention_percentage` preenchidos; reaplicar o evento nao cria a segunda;
11. com a chave em `false` (default) -> **nenhuma** linha no ledger, mesmo com a escola configurada;
    escola sem percentual / com `retention_enabled = false` -> sem lancamento e
    `payments.retention_status='not_applicable'`; evento que nao confirma dinheiro (`overdue`) -> sem
    `payments` e sem ledger;
12. `PAYMENT_REFUNDED` depois do lancamento -> `entry_type='reversal'` com o mesmo valor,
    `retained_amount` de volta a `0` e `GET /schools/:id/retention` com `retainedAmount` liquido
    (`retentionAmount` e `reversedAmount` como detalhe).

## 9. Ordem de implementacao e pendencias

1. `0014_asaas_events_consumer.sql` (contador/lease + indice unico do ledger) com o pre-flight da
   secao 6 rodado antes em `voa_staging` - **feito**;
2. `domain/asaas-events.ts` (mapa puro) + testes unitarios - nada toca banco - **feito**;
3. `db/asaas-events.ts` (claim/done/fail/resumo/retry) espelhando `db/outbox.ts` - **feito**;
4. `outbox/events.ts` (handler) **sem** ledger, com `RETENTION_LEDGER_ENABLED=false` de default -
   **feito**;
5. endpoints de operacao + testes de integracao - **feito**;
6. ledger: `schools.retention_percentage` (`0015`), `PATCH /schools/:id`, lancamento de `retention` e
   `reversal` no consumidor e `retainedAmount` liquido na rota da escola - **feito**, atras da chave.

Pendencias que **nao** bloqueiam mais o ledger (a fonte do percentual foi decidida): se
`entry_type='release'` nasce de acao humana (hoje nao existe rota de repasse) ou de evento do provedor;
e o que fazer com `PAYMENT_RECEIVED_IN_CASH_UNDONE` (proposta: `ignored` na v1, com ajuste manual,
porque dinheiro em especie nao passa pelo fluxo `billingType = UNDEFINED/BOLETO/PIX`).
