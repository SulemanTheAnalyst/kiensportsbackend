import { PaymentMethod, Prisma } from '@prisma/client';

// Provider-agnostic payment abstraction. A new provider (Cashfree, PayU...)
// implements this interface and is selected via PAYMENT_PROVIDER.
export interface PaymentSession {
  provider: string;
  // Public checkout payload handed to the frontend (never contains secrets).
  checkoutPayload: Record<string, unknown>;
  providerOrderId: string;
}

export interface WebhookEvent {
  providerOrderId: string | null;
  providerPaymentId: string | null;
  status: 'CAPTURED' | 'FAILED';
  amountPaise: number;
  raw: unknown;
}

export interface PaymentGateway {
  name: string;
  supports(method: PaymentMethod): boolean;
  // Minimal order shape providers need; decoupled from the caller's Prisma include.
  createOrder(order: PayableOrder, payment: Prisma.PaymentGetPayload<Record<string, never>>): Promise<PaymentSession>;
  verifyWebhook(rawBody: Buffer, signature: string | undefined, headers: Record<string, string | string[] | undefined>): WebhookEvent | null;
  refund(providerPaymentId: string, amountPaise: number, providerRefundId?: string): Promise<{ status: string }>;
}

// An order carrying its payment records - the minimum createOrder + session
// creation need. Orders fetched with richer includes remain assignable.
export type PayableOrder = Prisma.OrderGetPayload<{ include: { payments: true } }>;
