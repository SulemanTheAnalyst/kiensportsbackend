import { createHmac, timingSafeEqual } from 'crypto';
import Razorpay from 'razorpay';
import { Payment, PaymentMethod, Prisma } from '@prisma/client';
import type { PayableOrder, PaymentGateway, PaymentSession, WebhookEvent } from './gateway.types';

// Reads the secret directly from process.env so the gateway is testable
// without booting the full validated environment.
const webhookSecret = () => process.env.PAYMENT_WEBHOOK_SECRET || '';

// Razorpay driver. Credentials come only from environment variables.
// Webhook signature: HMAC-SHA256(rawBody, PAYMENT_WEBHOOK_SECRET).
//
// The SDK client is created lazily: webhook SIGNATURE VERIFICATION never
// talks to the Razorpay API and must not require API keys. The webhook
// route constructs this gateway purely to verify signatures, and the app
// boots (and tests run) with PAYMENT_PROVIDER=mock where no Razorpay keys
// exist. The Razorpay SDK constructor throws on a missing key_id, so a
// eagerly-created client would break signature verification in that setup.
export class RazorpayGateway implements PaymentGateway {
  name = 'razorpay';
  private keyId: string;
  private keySecret: string;
  private client: Razorpay | null = null;

  constructor(keyId: string, keySecret: string) {
    this.keyId = keyId;
    this.keySecret = keySecret;
  }

  // Only createOrder/refund need the API client; create it on first use so
  // verification-only instances work without credentials.
  private getClient(): Razorpay {
    if (!this.client) {
      this.client = new Razorpay({ key_id: this.keyId, key_secret: this.keySecret });
    }
    return this.client;
  }

  supports(method: PaymentMethod): boolean {
    return method !== PaymentMethod.COD; // COD is not gateway-captured
  }

  async createOrder(order: PayableOrder, payment: Payment): Promise<PaymentSession> {
    const rpOrder = await this.getClient().orders.create({
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

  verifyWebhook(rawBody: Buffer, signature: string | undefined, _headers: Record<string, string | string[] | undefined> = {}): WebhookEvent | null {
    if (!signature) return null;
    const expected = createHmac('sha256', webhookSecret()).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    let parsed: {
      event?: string;
      payload?: { payment?: { entity?: { id: string; order_id: string; status: string; amount: number; currency?: string } } };
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
      currency: entity.currency ?? null,
      raw: { event: parsed.event },
    };
  }

  async refund(providerPaymentId: string, amountPaise: number): Promise<{ status: string }> {
    const result = await this.getClient().payments.refund(providerPaymentId, { amount: amountPaise });
    return { status: (result as { status?: string }).status ?? 'INITIATED' };
  }
}
