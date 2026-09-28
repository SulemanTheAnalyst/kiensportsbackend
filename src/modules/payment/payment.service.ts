import { PaymentMethod, Prisma } from '@prisma/client';
import { env, isProd } from '../../config/env';
import { badRequest, notFound } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { MockGateway } from './mock.gateway';
import { RazorpayGateway } from './razorpay.gateway';
import type { PaymentGateway, PaymentSession } from './gateway.types';
import { confirmOrderPayment } from '../order/order.service';

// The gateway is a singleton chosen at boot via PAYMENT_PROVIDER.
// The mock provider is refused in production so we never pretend payments work.
const buildGateway = (): PaymentGateway => {
  if (env.PAYMENT_PROVIDER === 'razorpay') {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      throw new Error('PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
    }
    return new RazorpayGateway(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET);
  }
  if (isProd) {
    throw new Error('PAYMENT_PROVIDER=mock is not allowed in production');
  }
  return new MockGateway();
};

const gateway = buildGateway();

export const paymentService = {
  providerName: () => gateway.name,
  supports: (method: PaymentMethod) => gateway.supports(method),

  // Create the provider session for an order's latest CREATED payment.
  async createPaymentSession(
    order: Prisma.OrderGetPayload<{ include: { items: true; payments: true } }>,
  ): Promise<PaymentSession> {
    const payment = order.payments.find((p) => p.status === 'CREATED') ?? order.payments[order.payments.length - 1];
    if (!payment) throw notFound('Payment record missing for order ' + order.orderNumber);
    if (!this.supports(payment.method)) {
      throw badRequest('Payment method not supported by the configured provider');
    }
    if (payment.method === PaymentMethod.COD) {
      // COD is confirmed operationally, not by a gateway; return a marker payload.
      return {
        provider: 'cod',
        providerOrderId: 'cod_' + order.orderNumber,
        checkoutPayload: { mode: 'cod', instructions: 'Cash on delivery - pay when the order arrives.' },
      };
    }
    const session = await gateway.createOrder(order, payment);
    await prisma.payment.update({
      where: { id: payment.id },
      data: { provider: session.provider, providerOrderId: session.providerOrderId },
    });
    return session;
  },

  // Handle a verified provider webhook. Returns the updated order.
  async handleVerifiedWebhook(event: {
    providerOrderId: string | null;
    providerPaymentId: string | null;
    status: 'CAPTURED' | 'FAILED';
    amountPaise: number;
  }) {
    if (!event.providerPaymentId) throw badRequest('Webhook payload missing payment id');
    const payment = await prisma.payment.findFirst({
      where: { providerPaymentId: event.providerPaymentId },
    });
    if (!payment) {
      logger.warn({ providerPaymentId: event.providerPaymentId }, 'Webhook for unknown payment');
      throw notFound('Unknown payment');
    }
    // Amount check: the webhook amount must match what we charged.
    if (event.status === 'CAPTURED' && event.amountPaise !== payment.amountPaise) {
      logger.error(
        { expected: payment.amountPaise, got: event.amountPaise },
        'Webhook amount mismatch - ignoring',
      );
      throw badRequest('Payment amount mismatch');
    }
    if (event.status === 'CAPTURED') {
      return confirmOrderPayment(event.providerPaymentId);
    }
    return payment.orderId;
  },

  async refund(providerPaymentId: string, amountPaise: number) {
    return gateway.refund(providerPaymentId, amountPaise);
  },
};
