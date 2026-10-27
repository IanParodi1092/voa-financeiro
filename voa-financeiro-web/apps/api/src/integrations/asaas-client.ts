import { ProviderError } from '../domain/outbox.js';

/**
 * Cliente Asaas: contrato (`AsaasClient`) + implementacao HTTP.
 *
 * O worker depende **so da interface**, nunca de `fetch` - e o que mantem o teste sem rede e o dia em
 * que o provedor mudar de payload restrito a um arquivo. Toda falha sai como `ProviderError`, com
 * `status` quando houve resposta HTTP e **sem** `status` quando a chamada saiu e a resposta se perdeu
 * (timeout, `ECONNRESET`): e essa distincao que a classificacao da secao 7 usa para decidir o que
 * conciliar antes de reenviar.
 */

export const ASAAS_BILLING_TYPES = ['BOLETO', 'PIX', 'CREDIT_CARD', 'UNDEFINED'] as const;

export type AsaasBillingType = (typeof ASAAS_BILLING_TYPES)[number];

export interface AsaasCustomerInput {
  name: string;
  documentNumber?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  /** `dedupeKey` da fila: permite achar o cliente no provedor sem reenviar. */
  externalReference: string;
}

export interface AsaasChargeInput {
  asaasCustomerId: string;
  billingType: AsaasBillingType;
  value: number;
  /** `YYYY-MM-DD`. */
  dueDate: string;
  description?: string | undefined;
  /** `dedupeKey` da fila (`asaas.charge.create:<installment_id>`). */
  externalReference: string;
}

export interface AsaasCustomer {
  externalId: string;
}

export interface AsaasCharge {
  externalId: string;
  status: string;
  invoiceUrl: string | null;
  bankSlipUrl: string | null;
}

export interface AsaasClient {
  createCustomer(input: AsaasCustomerInput): Promise<AsaasCustomer>;
  createCharge(input: AsaasChargeInput): Promise<AsaasCharge>;
  /** Conciliacao: `null` quando o provedor nao tem cobranca com esta `externalReference`. */
  findChargeByExternalReference(externalReference: string): Promise<AsaasCharge | null>;
}

export interface AsaasClientOptions {
  /** `https://api-sandbox.asaas.com/v3` ou `https://api.asaas.com/v3`. */
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

interface AsaasPaymentBody {
  id?: unknown;
  status?: unknown;
  invoiceUrl?: unknown;
  bankSlipUrl?: unknown;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeCharge(body: AsaasPaymentBody): AsaasCharge {
  const externalId = textOf(body.id);
  if (!externalId) throw new ProviderError('asaas response without payment id');
  return {
    externalId,
    status: textOf(body.status) ?? 'unknown',
    invoiceUrl: textOf(body.invoiceUrl),
    bankSlipUrl: textOf(body.bankSlipUrl)
  };
}

/** `Retry-After` em segundos; o Asaas nao manda data HTTP, entao so o inteiro e lido. */
function retryAfterOf(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Mensagem de erro do provedor (`{ errors: [{ code, description }] }`), sem despejar o corpo inteiro. */
function errorMessageOf(text: string): string {
  if (!text) return 'empty response';
  try {
    const parsed = JSON.parse(text) as { errors?: { code?: string; description?: string }[] };
    const first = parsed.errors?.[0];
    if (first?.description) return first.code ? `${first.code}: ${first.description}` : first.description;
  } catch {
    // corpo nao-JSON (HTML de gateway): cai no texto cru truncado abaixo
  }
  return text.slice(0, 200);
}

/**
 * Implementacao com `fetch` global.
 *
 * `AbortSignal.timeout` cobre o caso que a fila precisa distinguir: a requisicao que **pode** ter sido
 * processada. O `access_token` vai no header (nao em query string) para nao aparecer em log de proxy.
 */
export function createAsaasClient(options: AsaasClientOptions): AsaasClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 30_000;

  const request = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          access_token: options.apiKey,
          'content-type': 'application/json',
          'user-agent': 'voa-financeiro-api'
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      const message = error instanceof Error && error.message ? error.message : 'request aborted';
      throw new ProviderError(`${method} ${path} sem resposta (${name}: ${message})`, { cause: error });
    }
    const text = await response.text();
    if (!response.ok) {
      const retryAfterSeconds = retryAfterOf(response.headers);
      throw new ProviderError(`${method} ${path} -> ${errorMessageOf(text)}`, {
        status: response.status,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
      });
    }
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new ProviderError(`${method} ${path} respondeu JSON invalido`, {
        status: response.status,
        cause: error
      });
    }
  };

  return {
    async createCustomer(input) {
      const body = (await request('POST', '/customers', {
        name: input.name,
        cpfCnpj: input.documentNumber,
        email: input.email,
        phone: input.phone,
        externalReference: input.externalReference
      })) as { id?: unknown };
      const externalId = textOf(body.id);
      if (!externalId) throw new ProviderError('asaas customer response without id');
      return { externalId };
    },

    async createCharge(input) {
      const body = await request('POST', '/payments', {
        customer: input.asaasCustomerId,
        billingType: input.billingType,
        value: input.value,
        dueDate: input.dueDate,
        description: input.description,
        externalReference: input.externalReference
      });
      return normalizeCharge(body as AsaasPaymentBody);
    },

    async findChargeByExternalReference(externalReference) {
      const query = new URLSearchParams({ externalReference, limit: '1' });
      const body = (await request('GET', `/payments?${query.toString()}`)) as { data?: AsaasPaymentBody[] };
      const first = Array.isArray(body.data) ? body.data[0] : undefined;
      return first ? normalizeCharge(first) : null;
    }
  };
}
