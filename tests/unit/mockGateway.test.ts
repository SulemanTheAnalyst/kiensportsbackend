import { describe, expect, it } from 'vitest';
import { MockGateway } from '../../src/modules/payment/mock.gateway';

describe('mock gateway pay-token HMAC', () => {
  const gw = new MockGateway();
  const orderId = 'mock_order_abc123';
  const paymentId = 'pay_0001';
  const amountPaise = 499900;

  it('verifies a token it signed', () => {
    const token = gw.signMockPayToken(orderId, paymentId, amountPaise);
    expect(gw.verifyMockPayToken(orderId, paymentId, amountPaise, token)).toBe(true);
  });

  it('rejects a tampered amount', () => {
    const token = gw.signMockPayToken(orderId, paymentId, amountPaise);
    expect(gw.verifyMockPayToken(orderId, paymentId, 100, token)).toBe(false);
  });

  it('rejects a wrong token length without throwing', () => {
    expect(gw.verifyMockPayToken(orderId, paymentId, amountPaise, 'deadbeef')).toBe(false);
  });
});
