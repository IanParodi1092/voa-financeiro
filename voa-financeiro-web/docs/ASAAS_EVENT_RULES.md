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
faz `ON CONFLICT (external_id) DO UPDATE`, nunca um segundo lancamento.

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
2. **Quanto**: `round(payment.value * percentual, 2)`, com o percentual em
   `payments.retention_percentage` (`numeric(5,4)` com `CHECK 0..1`, coluna da `0008`).
3. **`entry_type`**: `retention` na entrada; `release` quando o repasse sai; `reversal` quando o
   pagamento e estornado depois de a retencao ter sido lancada.
4. **Escola sem retencao** (`schools.retention_enabled = false`) ou percentual nulo: **nenhum
   lancamento**, e `payments.retention_status = 'not_applicable'`. Nao inventar percentual.
5. **Idempotencia** (secao 15, item 4 do desenho): indice unico parcial em
   `retention_ledger (payment_id, entry_type) WHERE payment_id IS NOT NULL` **e** `SELECT ... WHERE
   NOT EXISTS` no handler. O indice e a trava; o `NOT EXISTS` mantem o codigo correto num banco que
   ainda nao aplicou a `0014`. Reaplicar o evento vira `ON CONFLICT DO NOTHING`.

> **Lacuna de negocio, nao de codigo**: no fluxo legado o percentual vem da planilha
> (`Pagamento_Lista` -> `payments.retention_percentage`). Para um pagamento **novo** vindo do Asaas
> nao existe fonte canonica de percentual hoje. Opcoes, em ordem de preferencia:
>
> 1. `schools.retention_percentage numeric(5,4)` (`0014`) + `PATCH /api/v1/schools/:id`: uma regra por
>    escola, versionavel e editavel por `catalog:write`;
> 2. continuar em `payments.retention_percentage`, preenchido por `PATCH /payments/:id` antes da baixa:
>    flexivel por parcela, mas depende de alguem preencher e a cobranca pode ser paga antes;
> 3. derivar de `retention_target_amount`: **nao serve** - meta e total, nao fracao.
>
> Recomendacao: opcao 1, com `NULL` significando "escola sem retencao" e `retention_enabled` como
> interruptor. Enquanto a decisao nao vier, o consumidor aplica status e `payments` normalmente e o
> lancamento no ledger fica atras de `RETENTION_LEDGER_ENABLED` (default `false`).

## 6. O que falta no schema (`0014_asaas_events_consumer.sql`)

O desenho da secao 9 fala em "teto de tentativas", mas `asaas_events` **nao tem contador** - hoje so
existem `processed_at`, `failed_at` e `failure_reason`. Sem coluna, o consumidor nao distingue "nunca
tentou" de "tentou 5 vezes".

| Mudanca | Motivo | Risco |
|---|---|---|
| `asaas_events.attempts int NOT NULL DEFAULT 0` | teto do `WEBHOOK_RETRY_LIMIT` por evento | nenhum (default cobre as linhas existentes) |
| `asaas_events.last_attempt_at timestamptz` | separar "preso" de "esperando", igual a `locked_at` do outbox | nenhum |
| `UNIQUE` parcial `payments (external_id) WHERE source = 'asaas' AND external_id IS NOT NULL` | o `ON CONFLICT (external_id)` do consumidor exige a chave; restringir a `source = 'asaas'` evita colidir com `external_id` repetido da carga legada | verificar duplicados antes de aplicar |
| `UNIQUE` parcial `retention_ledger (payment_id, entry_type) WHERE payment_id IS NOT NULL` | trava do item 4 | idem: `SELECT payment_id, entry_type, count(*) ... GROUP BY 1,2 HAVING count(*) > 1` |
| (se opcao 1 da secao 5) `schools.retention_percentage numeric(5,4) CHECK (0..1)` + `PATCH /schools/:id` | fonte canonica do percentual para pagamento novo | decisao de negocio ainda aberta |

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

Rodado em `voa_staging` em 2026-10-27: **0 duplicados** nas duas tabelas, `payments` com
`source = 'asaas'` ainda em `0` linhas (a carga legada usa outra fonte) e `asaas_events` vazia. Ou
seja, os dois indices unicos parciais entram sem backfill nem correcao de dado.

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
10. retencao com `RETENTION_LEDGER_ENABLED=true` e percentual configurado -> uma linha
    `entry_type='retention'` com `round(value * pct, 2)`; reaplicar o evento nao cria a segunda.

## 9. Ordem de implementacao e pendencias

1. `0014_asaas_events_consumer.sql` (contador + indices unicos parciais) com o pre-flight da secao 6
   rodado antes em `voa_staging`;
2. `domain/asaas-events.ts` (mapa puro) + testes unitarios - nada toca banco;
3. `db/asaas-events.ts` (claim/done/fail/resumo/retry) espelhando `db/outbox.ts`;
4. `outbox/events.ts` (handler) **sem** ledger, com `RETENTION_LEDGER_ENABLED=false` de default;
5. endpoints de operacao + testes de integracao;
6. ledger ligado, depois de decidida a fonte do percentual (secao 5).

Pendencias que bloqueiam apenas o item 6: fonte do percentual de retencao; se `entry_type='release'`
nasce de acao humana (hoje nao existe rota de repasse) ou de evento do provedor; e o que fazer com
`PAYMENT_RECEIVED_IN_CASH_UNDONE` (proposta: `ignored` na v1, com ajuste manual, porque dinheiro em
especie nao passa pelo fluxo `billingType = UNDEFINED/BOLETO/PIX`).
