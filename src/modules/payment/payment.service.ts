import { PaymentMethod, Prisma } from '@prisma/client';
import { env, isProd } from '../../config/env';
import { badRequest, notFound } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { MockGateway } from './mock.gateway';
import { RazorpayGateway } from './razorpay.gateway';
import type { PayableOrder, PaymentGateway, PaymentSession } from './gateway.types';
import { confirmOrderPayment, failOrderPayment } from '../order/order.service';

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
    order: PayableOrder,
  ): Promise<PaymentSession> {
    const payment = order.payments.find((p) => p.status === 'CREATED') ?? order.payments[order.payments.length - 1];
    if (!payment) throw notFound('Payment record missing for order ' + order.orderNumber);
    // COD is an operational flow, never an online-gateway flow, so it must be
    // handled BEFORE the gateway supports() check. RazorpayGateway.supports()
    // returns false for COD, and the previous ordering made every production
    // COD checkout throw 'Payment method not supported' AFTER the order
    // transaction had already committed - the root cause of the transient
    // 'Invalid payment method' error on COD checkout.
    if (payment.method === PaymentMethod.COD) {
      // COD is confirmed operationally, not by a gateway; return a marker payload.
      await prisma.payment.update({
        where: { id: payment.id },
        data: { provider: 'cod', providerOrderId: 'cod_' + order.orderNumber, status: 'COD_PENDING' },
      });
      return {
        provider: 'cod',
        providerOrderId: 'cod_' + order.orderNumber,
        checkoutPayload: { mode: 'cod', instructions: 'Cash on delivery - pay when the order arrives.' },
      };
    }
    if (!this.supports(payment.method)) {
      throw badRequest('Payment method not supported by the configured provider');
    }
    const session = await gateway.createOrder(order, payment);
    await prisma.payment.update({
      where: { id: payment.id },
      data: { provider: session.provider, providerOrderId: session.providerOrderId },
    });
    return session;
  },

  // Handle a verified provider webhook. Returns the updated order.
  //
  // Matching strategy (Razorpay sends the payment id only in the webhook;
  // our Payment row only stores the provider ORDER id at session creation):
  //  1. Direct lookup by providerPaymentId - covers replays and any path
  //     where the payment id was already persisted (e.g. the mock simulator).
  //  2. Otherwise resolve via the providerOrderId we persisted when the
  //     session was created, then ATOMICALLY CLAIM the providerPaymentId on
  //     that row. The conditional update (providerPaymentId still null,
  //     status still CREATED) plus the unique constraint on
  //     (provider, providerOrderId, providerPaymentId) make the claim safe
  //     against concurrent duplicate webhooks and prevent one provider
  //     payment from being attached to an unrelated order.
  async handleVerifiedWebhook(event: {
    providerOrderId: string | null;
    providerPaymentId: string | null;
    status: 'CAPTURED' | 'FAILED';
    amountPaise: number;
    currency?: string | null;
  }) {
    if (!event.providerPaymentId) throw badRequest('Webhook payload missing payment id');

    let payment = await prisma.payment.findFirst({
      where: { providerPaymentId: event.providerPaymentId },
    });

    if (!payment) {
      if (!event.providerOrderId) {
        logger.warn({ providerPaymentId: event.providerPaymentId }, 'Webhook for unknown payment');
        throw notFound('Unknown payment');
      }
      const session = await prisma.payment.findFirst({
        where: { providerOrderId: event.providerOrderId },
        orderBy: { createdAt: 'desc' },
      });
      if (!session) {
        logger.warn(
          { providerOrderId: event.providerOrderId, providerPaymentId: event.providerPaymentId },
          'Webhook for unknown payment',
        );
        throw notFound('Unknown payment');
      }
      // Atomic claim: only one concurrent webhook can win. If we lose, the
      // winner already stored this id - fall through to the re-fetch below.
      const claim = await prisma.payment.updateMany({
        where: {
          id: session.id,
          providerPaymentId: null,
          status: { in: ['CREATED', 'EXPIRED', 'FAILED'] },
        },
        data: { providerPaymentId: event.providerPaymentId },
      });
      if (claim.count === 0) {
        payment = await prisma.payment.findFirst({
          where: { providerPaymentId: event.providerPaymentId },
        });
        if (!payment) {
          logger.warn({ providerPaymentId: event.providerPaymentId }, 'Webhook for unknown payment');
          throw notFound('Unknown payment');
        }
      } else {
        payment = session;
      }
    }

    // The provider payment must belong to the provider order it references.
    // A valid payment id paired with a foreign order id is rejected outright:
    // one provider payment can never be attached to an unrelated order.
    if (payment.providerOrderId && event.providerOrderId && payment.providerOrderId !== event.providerOrderId) {
      logger.error(
        { paymentId: payment.id, expected: payment.providerOrderId, got: event.providerOrderId },
        'Webhook provider order mismatch - ignoring',
      );
      throw badRequest('Webhook does not match the payment order');
    }

    // Amount check: the webhook amount must match what we charged.
    if (event.status === 'CAPTURED' && event.amountPaise !== payment.amountPaise) {
      logger.error(
        { expected: payment.amountPaise, got: event.amountPaise },
        'Webhook amount mismatch - ignoring',
      );
      throw badRequest('Payment amount mismatch');
    }

    // Currency check: we only ever charge INR.
    if (event.status === 'CAPTURED' && event.currency && event.currency !== 'INR') {
      logger.error(
        { expected: 'INR', got: event.currency },
        'Webhook currency mismatch - ignoring',
      );
      throw badRequest('Payment currency mismatch');
    }

    if (event.status === 'CAPTURED') {
      return confirmOrderPayment(event.providerPaymentId);
    }

    // Verified failure: mark the payment attempt failed and release the
    // inventory reservation so stock is not held forever by abandoned or
    // failed checkouts. Both updates are idempotent on replay.
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
    await failOrderPayment(payment.orderId, 'Provider reported the payment as failed');
    return payment.orderId;
  },

  async refund(providerPaymentId: string, amountPaise: number) {
    return gateway.refund(providerPaymentId, amountPaise);
  },
};

