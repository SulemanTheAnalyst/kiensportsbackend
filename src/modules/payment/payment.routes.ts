import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { validate } from '../../middleware/validate';
import { optionalAuth, requireAuth } from '../../middleware/auth';
import { apiLimiter } from '../../middleware/errorHandler';
import { createOrder, getOrderForCustomer, listCustomerOrders, expirePendingOrderIfStale } from '../order/order.service';
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

// Orders are tied to an authenticated customer. Guests can browse and fill a
// cart, but order creation requires a verified session; the customer identity
// is taken from req.user (set by the trusted token middleware), never from
// the request body.
orderRouter.post(
  '/',
  apiLimiter(10 * 60_000, 20),
  requireAuth,
  validate({
    body: z.object({
      email: z.string().email().max(254),
      address: addressSchema,
      paymentMethod: z.enum(['CARD', 'UPI', 'COD']),
      couponCode: z.string().trim().min(2).max(24).optional(),
    }),
  }),
  async (req, res) => {
    // Map the validated body onto the service contract explicitly. (The body
    // key is `paymentMethod`; the service expects `method`. Passing the raw
    // body previously left `method` undefined and made every valid checkout
    // fail with a 500 at payment-record creation.)
    const { order, payment } = await createOrder(req, {
      email: req.body.email,
      address: req.body.address,
      method: req.body.paymentMethod,
      couponCode: req.body.couponCode,
    });
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
    let order = await prisma.order.findUnique({ where: { orderNumber: String(req.params.orderNumber) } });
    if (!order) throw badRequest('Order not found');
    // Lazy expiry: when this prepaid attempt is older than the configured
    // TTL, expire it now (cancel the order, release the reservation) instead
    // of letting the customer poll a dead checkout forever. A concurrent
    // verified webhook can never be overwritten (row lock + status re-check).
    if (order.status === 'PENDING_PAYMENT') {
      await expirePendingOrderIfStale(order.orderNumber);
      order = await prisma.order.findUniqueOrThrow({ where: { orderNumber: order.orderNumber } });
    }
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
    res.json({ data: await getOrderForCustomer(req.user?.sub ?? null, String(req.params.orderNumber), true) });
  },
);

// ---------------- Payment webhooks ----------------

export const paymentWebhookRouter = Router();

// Raw body is required for signature verification (configured in app.ts).
paymentWebhookRouter.post('/webhook/:provider', async (req, res) => {
  const provider = String(req.params.provider);
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
