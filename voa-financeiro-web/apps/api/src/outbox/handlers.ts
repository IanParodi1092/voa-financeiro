import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { ClaimedMessage } from '../db/outbox.js';
import { OutboxPayloadError, classifyFailure, type OutboxEnvironment, type OutboxTopic } from '../domain/outbox.js';
import type { AsaasCharge, AsaasClient } from '../integrations/asaas-client.js';

/**
 * Handlers dos topics: o unico lugar que sabe traduzir uma linha da fila em chamada ao Asaas e em
 * escrita local.
 *
 * Tres regras que valem para todos os handlers:
 *
 * 1. **O payload e validado aqui** (`zod`). Uma linha com payload invalido vira `OutboxPayloadError`
 *    e a classificacao a marca `dead` na primeira tentativa - reenviar o mesmo dado produziria o
 *    mesmo erro.
 * 2. **A escrita local acontece depois do provedor**, com `ON CONFLICT` que reaplica o mesmo estado.
 *    Um replay (crash entre o POST e o `done`) nao cria segunda cobranca: `external_id` e o mesmo.
 * 3. **A conciliacao (secao 8 do desenho) mora no handler**, nao no cliente HTTP: antes de reenviar
 *    uma cobranca cuja tentativa anterior foi ambigua, pergunta ao provedor pela `externalReference`.
 */

export interface HandlerContext {
  pool: Pool;
  asaas: AsaasClient;
  environment: OutboxEnvironment;
  logger: FastifyBaseLogger;
  message: ClaimedMessage;
}

/** O que o handler devolve ao worker: `note` vai para `last_error` (ex.: recuperado por conciliacao). */
export interface HandlerResult {
  note?: string;
}

export type TopicHandler = (context: HandlerContext) => Promise<HandlerResult>;

function invalidPayload(topic: OutboxTopic, error: z.ZodError): OutboxPayloadError {
  const details = error.issues.map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`).join('; ');
  return new OutboxPayloadError(`${topic} com payload invalido: ${details}`, { cause: error });
}

const customerPayloadSchema = z.object({
  /** `customers.id` local: a FK de `asaas_customers` exige que o cliente exista. */
  customerId: z.string().uuid(),
  name: z.string().trim().min(2).max(200),
  documentNumber: z.string().trim().min(11).max(20).optional(),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().max(30).optional()
});

async function handleCustomerCreate(context: HandlerContext): Promise<HandlerResult> {
  const parsed = customerPayloadSchema.safeParse(context.message.payload);
  if (!parsed.success) throw invalidPayload(context.message.topic, parsed.error);
  const payload = parsed.data;

  const created = await context.asaas.createCustomer({
    name: payload.name,
    documentNumber: payload.documentNumber,
    email: payload.email,
    phone: payload.phone,
    externalReference: context.message.dedupeKey
  });

  await context.pool.query(
    `INSERT INTO asaas_customers (customer_id, external_id, environment, last_status, metadata)
     VALUES ($1, $2, $3, 'created', $4)
     ON CONFLICT (customer_id) DO UPDATE
       SET external_id = EXCLUDED.external_id, last_status = EXCLUDED.last_status, updated_at = now()`,
    [payload.customerId, created.externalId, context.environment, JSON.stringify({ outboxId: context.message.id })]
  );
  return {};
}

const chargePayloadSchema = z.object({
  installmentId: z.string().uuid(),
  /** `asaas_customers.id` local, nunca o id do provedor: a FK da tabela exige a linha daqui. */
  asaasCustomerId: z.string().uuid(),
  billingType: z.enum(['BOLETO', 'PIX', 'CREDIT_CARD', 'UNDEFINED']),
  value: z.number().positive().max(99_999_999.99),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().max(200).optional()
});

type ChargePayload = z.infer<typeof chargePayloadSchema>;

/**
 * Grava a cobranca do provedor em `asaas_charges`.
 *
 * `ON CONFLICT (external_id) DO UPDATE` e o que torna o replay inofensivo: a mesma cobranca devolvida
 * duas vezes atualiza a mesma linha em vez de estourar a UNIQUE. Os campos de URL sao reaplicados
 * porque o provedor pode preencher `bankSlipUrl` depois do primeiro retorno.
 */
async function persistCharge(
  context: HandlerContext,
  payload: ChargePayload,
  charge: AsaasCharge
): Promise<void> {
  await context.pool.query(
    `INSERT INTO asaas_charges (installment_id, asaas_customer_id, external_id, environment, billing_type,
                                value, due_date, status, invoice_url, bank_slip_url, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (external_id) DO UPDATE
       SET status = EXCLUDED.status, invoice_url = EXCLUDED.invoice_url,
           bank_slip_url = EXCLUDED.bank_slip_url, updated_at = now()`,
    [
      payload.installmentId,
      payload.asaasCustomerId,
      charge.externalId,
      context.environment,
      payload.billingType,
      payload.value,
      payload.dueDate,
      charge.status,
      charge.invoiceUrl,
      charge.bankSlipUrl,
      JSON.stringify({ outboxId: context.message.id })
    ]
  );
}

/** Busca a cobranca pela `externalReference`; falha de consulta nao derruba a tentativa. */
async function reconcile(context: HandlerContext): Promise<AsaasCharge | null> {
  try {
    return await context.asaas.findChargeByExternalReference(context.message.dedupeKey);
  } catch (error) {
    context.logger.warn(
      { err: error, dedupeKey: context.message.dedupeKey },
      'outbox reconciliation lookup failed'
    );
    return null;
  }
}

/**
 * Cria a cobranca, conciliando antes quando o resultado anterior foi ambiguo.
 *
 * Duas janelas justificam a consulta: (a) `attempts > 1` significa que uma tentativa anterior falhou
 * e pode ter criado a cobranca; (b) a tentativa atual pode falhar sem resposta (timeout), e nesse
 * caso o provedor pode ter processado. Em ambas, achar a cobranca pela `externalReference` encerra a
 * mensagem sem reenviar - que e a unica forma de nao duplicar dinheiro.
 */
async function handleChargeCreate(context: HandlerContext): Promise<HandlerResult> {
  const parsed = chargePayloadSchema.safeParse(context.message.payload);
  if (!parsed.success) throw invalidPayload(context.message.topic, parsed.error);
  const payload = parsed.data;

  const adopt = async (charge: AsaasCharge): Promise<HandlerResult> => {
    await persistCharge(context, payload, charge);
    return { note: 'recovered by reconciliation' };
  };

  if (context.message.attempts > 1) {
    const existing = await reconcile(context);
    if (existing) return adopt(existing);
  }

  try {
    const created = await context.asaas.createCharge({
      asaasCustomerId: payload.asaasCustomerId,
      billingType: payload.billingType,
      value: payload.value,
      dueDate: payload.dueDate,
      ...(payload.description === undefined ? {} : { description: payload.description }),
      externalReference: context.message.dedupeKey
    });
    await persistCharge(context, payload, created);
    return {};
  } catch (error) {
    if (!classifyFailure(error).ambiguous) throw error;
    const existing = await reconcile(context);
    if (existing) return adopt(existing);
    throw error;
  }
}

/** Um handler por topic. O `CHECK` da migration garante que so estes dois chegam aqui. */
export const topicHandlers: Record<OutboxTopic, TopicHandler> = {
  'asaas.customer.create': handleCustomerCreate,
  'asaas.charge.create': handleChargeCreate
};
