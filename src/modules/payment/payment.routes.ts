import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { validate } from '../../middleware/validate';
import { optionalAuth } from '../../middleware/auth';
import { apiLimiter } from '../../middleware/errorHandler';
import { createOrder, getOrderForCustomer, listCustomerOrders } from '../order/order.service';
import { paymentService } from './payment.service';
import { serializeOrder } from '../order/order.service';
import { MockGateway } from './mock.gateway';
import { paiseToRupees } from '../../lib/money';
import { env } from '../../config/env';
import { badRequest } from '../../lib/errors';

export const orderRouter = Router();

const addressSchema = z.object({
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  line1: z.string().min(3).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(2).max(80),
  state: z.string().min(2).max(80),
  pincode: z.string().regex(/^[1-9][0-9]{5}$/), // Indian PIN codes
  phone: z.string().regex(/^(\+91)?[6-9][0-9]{9}$/), // Indian mobile numbers
});

orderRouter.post(
  '/',
  apiLimiter(10 * 60_000, 20),
  optionalAuth,
  validate({
    body: z.object({
      email: z.string().email().max(254),
      address: addressSchema,
      paymentMethod: z.enum(['CARD', 'UPI', 'COD']),
    }),
  }),
  async (req, res) => {
    const { order, payment } = await createOrder(req, req.body);
    res.status(201).json({
      data: {
        order: serializeOrder(order),
        payment: {
          method: req.body.paymentMethod,
          provider: payment.provider,
          checkoutPayload: payment.checkoutPayload, // contains NO secrets
        },
      },
    });
  },
);

// Lightweight public status poll used right after checkout.
orderRouter.get(
  '/:orderNumber/status',
  validate({ params: z.object({ orderNumber: z.string().min(6).max(40) }) }),
  async (req, res) => {
    const order = await prisma.order.findUnique({ where: { orderNumber: req.params.orderNumber } });
    if (!order) throw badRequest('Order not found');
    // Public payload: only statuses and order number - no PII.
    res.json({
      data: { orderNumber: order.orderNumber, status: order.status, paymentStatus: order.paymentStatus },
    });
  },
);

orderRouter.get(
  '/:orderNumber',
  optionalAuth,
  validate({ params: z.object({ orderNumber: z.string().min(6).max(40) }) }),
  async (req, res) => {
    res.json({ data: await getOrderForCustomer(req.user?.sub ?? null, req.params.orderNumber, true) });
  },
);

// ---------------- Payment webhooks ----------------

export const paymentWebhookRouter = Router();

// Raw body is required for signature verification (configured in app.ts).
paymentWebhookRouter.post('/webhook/:provider', async (req, res) => {
  const provider = req.params.provider;
  if (provider !== paymentService.providerName() && provider !== 'razorpay') {
    throw badRequest('Unknown payment provider');
  }
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!rawBody) throw badRequest('Missing raw body for verification');
  const signature = req.headers['x-razorpay-signature'] as string | undefined;
  // Razorpay verification: HMAC-SHA256 over the raw body with the webhook secret.
  const { RazorpayGateway } = await import('./razorpay.gateway');
  const gw = new RazorpayGateway(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET);
  const event = gw.verifyWebhook(rawBody, signature);
  if (!event) {
    // Signature failure: 400, never process, never leak details.
    throw badRequest('Invalid webhook signature');
  }
  await paymentService.handleVerifiedWebhook(event);
  res.json({ data: { ok: true } });
});

// Sandbox-only payment simulator for the mock gateway (development/test).
paymentWebhookRouter.post(
  '/mock/pay',
  async (req, res) => {
    if (env.PAYMENT_PROVIDER !== 'mock') throw badRequest('Mock payments are disabled');
    const bodySchema = z.object({
      providerOrderId: z.string().min(6),
      paymentId: z.string().min(6),
      payToken: z.string().min(32),
    });
    const body = bodySchema.parse(req.body);
    const payment = await prisma.payment.findFirst({
      where: { providerOrderId: body.providerOrderId, id: body.paymentId },
      include: { order: true },
    });
    if (!payment) throw badRequest('Unknown mock payment');
    const mock = new MockGateway();
    if (!mock.verifyMockPayToken(body.providerOrderId, body.paymentId, payment.amountPaise, body.payToken)) {
      throw badRequest('Invalid mock pay token');
    }
    const providerPaymentId = 'mock_pay_' + payment.id;
    await prisma.payment.update({
      where: { id: payment.id },
      data: { providerPaymentId, status: 'CAPTURED', webhookVerifiedAt: new Date() },
    });
    const { confirmOrderPayment } = await import('../order/order.service');
    const order = await confirmOrderPayment(providerPaymentId);
    res.json({ data: { orderNumber: order.orderNumber, status: order.status, total: paiseToRupees(order.totalPaise) } });
  },
);
