import { createHmac, randomBytes } from 'crypto';
import { PaymentMethod, Prisma } from '@prisma/client';
import { logger } from '../../lib/logger';
import type { PaymentGateway, PaymentSession, WebhookEvent } from './gateway.types';

// Reads the secret directly from process.env so the gateway is testable
// without booting the full validated environment.
const webhookSecret = () => process.env.PAYMENT_WEBHOOK_SECRET || 'change-me';

// Mock gateway: sandbox-only. Lets the full checkout flow be developed and
// tested WITHOUT pretending real money moves. In production, PAYMENT_PROVIDER
// must be a real provider; the app refuses to boot the mock in production.
export class MockGateway implements PaymentGateway {
  name = 'mock';

  supports(method: PaymentMethod): boolean {
    return method === PaymentMethod.CARD || method === PaymentMethod.UPI || method === PaymentMethod.COD;
  }

  async createOrder(order, payment): Promise<PaymentSession> {
    const providerOrderId = 'mock_order_' + randomBytes(8).toString('hex');
    return {
      provider: this.name,
      providerOrderId,
      checkoutPayload: {
        mode: 'mock',
        providerOrderId,
        // Sandbox-only: a signed token the test client can post to the
        // webhook simulator (POST /api/v1/payments/mock/pay).
        payToken: this.signMockPayToken(providerOrderId, payment.id, order.totalPaise),
        amountPaise: order.totalPaise,
      },
    };
  }

  signMockPayToken(providerOrderId: string, paymentId: string, amountPaise: number): string {
    return createHmac('sha256', webhookSecret())
      .update(providerOrderId + ':' + paymentId + ':' + amountPaise)
      .digest('hex');
  }

  verifyMockPayToken(providerOrderId: string, paymentId: string, amountPaise: number, token: string): boolean {
    const expected = this.signMockPayToken(providerOrderId, paymentId, amountPaise);
    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    return a.length === b.length && a.equals(b); // constant-time compare
  }

  // Mock webhooks are "verified" by their HMAC token (see mockPay route).
  verifyWebhook(_rawBody: Buffer, _signature, _headers): WebhookEvent | null {
    return null; // mock uses its own dedicated simulator route instead
  }

  async refund(providerPaymentId: string, _amountPaise: number): Promise<{ status: string }> {
    logger.warn({ providerPaymentId }, 'Mock refund - no real money moved');
    return { status: 'PROCESSED' };
  }
}
