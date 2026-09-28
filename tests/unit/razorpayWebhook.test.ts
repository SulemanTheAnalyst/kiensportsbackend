import { describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';
import { RazorpayGateway } from '../../src/modules/payment/razorpay.gateway';

// Signature verification is the security-critical path of the webhook.
describe('razorpay webhook signature verification', () => {
  const gw = new RazorpayGateway('test_key', 'test_secret');
  const secret = process.env.PAYMENT_WEBHOOK_SECRET || '';

  const body = JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: { entity: { id: 'pay_123', order_id: 'order_123', status: 'captured', amount: 499900 } },
    },
  });

  it('accepts a correctly signed payload', () => {
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    const event = gw.verifyWebhook(Buffer.from(body), signature);
    expect(event).not.toBeNull();
    expect(event!.status).toBe('CAPTURED');
    expect(event!.providerPaymentId).toBe('pay_123');
    expect(event!.amountPaise).toBe(499900);
  });

  it('rejects an invalid signature', () => {
    expect(gw.verifyWebhook(Buffer.from(body), 'not-a-valid-signature')).toBeNull();
  });

  it('rejects a missing signature', () => {
    expect(gw.verifyWebhook(Buffer.from(body), undefined)).toBeNull();
  });
});
