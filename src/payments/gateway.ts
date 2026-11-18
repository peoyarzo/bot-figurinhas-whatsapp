import { randomBytes } from 'node:crypto';
import type { Env } from '../env.js';

export type CreatePixInput = {
  amountCents: number;
  description: string;
  externalReference: string;
  payerEmail: string;
  payerFirstName: string;
  notificationUrl?: string;
};

export type PixPayment = {
  id: string;
  status: string;
  qrCode: string;
  externalReference: string;
};

export type RemotePayment = {
  id: string;
  status: string;
  externalReference?: string;
};

export interface PaymentGateway {
  readonly mode: 'mock' | 'mercadopago' | 'unconfigured';
  createPix(input: CreatePixInput): Promise<PixPayment>;
  getPayment(id: string): Promise<RemotePayment | null>;
}

export class PaymentNotConfiguredError extends Error {
  constructor() {
    super('Pix não configurado');
    this.name = 'PaymentNotConfiguredError';
  }
}

export class MockGateway implements PaymentGateway {
  readonly mode = 'mock' as const;
  private payments = new Map<string, PixPayment & { amountCents: number }>();

  async createPix(input: CreatePixInput): Promise<PixPayment> {
    const id = `mock${randomBytes(6).toString('hex')}`;
    const created = {
      id,
      status: 'pending',
      qrCode: `00020126MOCKPIX${id}5204000053039865802BR`,
      externalReference: input.externalReference,
      amountCents: input.amountCents,
    };
    this.payments.set(id, created);
    return created;
  }

  async getPayment(id: string): Promise<RemotePayment | null> {
    const found = this.payments.get(id);
    if (!found) return null;
    return { id: found.id, status: found.status, externalReference: found.externalReference };
  }

  approve(id: string): boolean {
    const found = this.payments.get(id);
    if (!found) return false;
    found.status = 'approved';
    return true;
  }
}

export class NotConfiguredGateway implements PaymentGateway {
  readonly mode = 'unconfigured' as const;

  async createPix(): Promise<PixPayment> {
    throw new PaymentNotConfiguredError();
  }

  async getPayment(): Promise<RemotePayment | null> {
    return null;
  }
}

export class MercadoPagoGateway implements PaymentGateway {
  readonly mode = 'mercadopago' as const;

  constructor(
    private readonly env: Env,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createPix(input: CreatePixInput): Promise<PixPayment> {
    const body: Record<string, unknown> = {
      transaction_amount: Number((input.amountCents / 100).toFixed(2)),
      description: input.description,
      payment_method_id: 'pix',
      external_reference: input.externalReference,
      payer: { email: input.payerEmail, first_name: input.payerFirstName },
    };
    if (input.notificationUrl) body.notification_url = input.notificationUrl;
    const response = await this.fetchImpl('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': input.externalReference,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    const json = (await response.json().catch(() => ({}))) as {
      id?: number | string;
      status?: string;
      message?: string;
      point_of_interaction?: { transaction_data?: { qr_code?: string } };
    };
    if (!response.ok) {
      throw new Error(`Mercado Pago recusou o Pix (${response.status})${json.message ? `: ${json.message}` : ''}`);
    }
    const qr = json.point_of_interaction?.transaction_data?.qr_code;
    if (json.id == null || !qr) throw new Error('Resposta do Mercado Pago sem QR Pix');
    return { id: String(json.id), status: String(json.status ?? 'pending'), qrCode: qr, externalReference: input.externalReference };
  }

  async getPayment(id: string): Promise<RemotePayment | null> {
    const response = await this.fetchImpl(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${this.env.MP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 404) return null;
    const json = (await response.json().catch(() => ({}))) as { id?: number | string; status?: string; external_reference?: string; message?: string };
    if (!response.ok) {
      throw new Error(`Falha ao consultar pagamento (${response.status})${json.message ? `: ${json.message}` : ''}`);
    }
    return {
      id: String(json.id ?? id),
      status: String(json.status ?? ''),
      externalReference: json.external_reference ? String(json.external_reference) : undefined,
    };
  }
}

export function createGateway(env: Env): PaymentGateway {
  if (env.MOCK_MP) return new MockGateway();
  if (!env.MP_ACCESS_TOKEN) return new NotConfiguredGateway();
  return new MercadoPagoGateway(env);
}
