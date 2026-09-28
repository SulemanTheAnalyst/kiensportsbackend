import { createHmac, timingSafeEqual } from 'crypto';
import Razorpay from 'razorpay';
import { PaymentMethod, Prisma } from '@prisma/client';
import type { PaymentGateway, PaymentSession, WebhookEvent } from './gateway.types';

// Reads the secret directly from process.env so the gateway is testable
// without booting the full validated environment.
const webhookSecret = () => process.env.PAYMENT_WEBHOOK_SECRET || '';

// Razorpay driver. Credentials come only from environment variables.
// Webhook signature: HMAC-SHA256(rawBody, PAYMENT_WEBHOOK_SECRET).
export class RazorpayGateway implements PaymentGateway {
  name = 'razorpay';
  private client: Razorpay;

  constructor(keyId: string, keySecret: string) {
    this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }

  supports(method: PaymentMethod): boolean {
    return method !== PaymentMethod.COD; // COD is not gateway-captured
  }

  async createOrder(order, payment): Promise<PaymentSession> {
    const rpOrder = await this.client.orders.create({
      amount: order.totalPaise,
      currency: 'INR',
      receipt: order.orderNumber,
      notes: { orderId: order.id, paymentId: payment.id },
    });
    return {
      provider: this.name,
      providerOrderId: rpOrder.id,
      checkoutPayload: {
        keyId: process.env.RAZORPAY_KEY_ID || '', // public key id - safe for the browser
        orderId: rpOrder.id,
        amount: order.totalPaise,
        currency: 'INR',
        name: 'KIEN Sports',
      },
    };
  }

  verifyWebhook(rawBody: Buffer, signature: string | undefined): WebhookEvent | null {
    if (!signature) return null;
    const expected = createHmac('sha256', webhookSecret()).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    let parsed: {
      event?: string;
      payload?: { payment?: { entity?: { id: string; order_id: string; status: string; amount: number } } };
    };
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    const entity = parsed.payload?.payment?.entity;
    if (!entity) return null;
    const captured = entity.status === 'captured' || parsed.event === 'payment.captured';
    return {
      providerOrderId: entity.order_id,
      providerPaymentId: entity.id,
      status: captured ? 'CAPTURED' : 'FAILED',
      amountPaise: entity.amount,
      raw: { event: parsed.event },
    };
  }

  async refund(providerPaymentId: string, amountPaise: number): Promise<{ status: string }> {
    const result = await this.client.payments.refund(providerPaymentId, { amount: amountPaise });
    return { status: (result as { status?: string }).status ?? 'INITIATED' };
  }
}
