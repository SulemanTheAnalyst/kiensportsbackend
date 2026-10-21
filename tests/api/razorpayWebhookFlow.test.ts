import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createHmac } from 'crypto';
import type { Express } from 'express';

// Integration test: requires a running Postgres (docker compose up -d db)
// and a migrated database (npx prisma db push). Skips automatically when
// DATABASE_URL is not configured. No Razorpay credentials and no real
// payments are involved: the webhook is simulated by signing the raw body
// with PAYMENT_WEBHOOK_SECRET, exactly the way Razorpay signs it.
//
// Regression coverage for the P0 defect where a verified captured webhook
// could not match the internal payment (providerPaymentId was unknown until
// capture time) and the order stayed PENDING_PAYMENT forever.
//
// Flow under test (src/modules/payment/payment.routes.ts webhook route ->
// RazorpayGateway.verifyWebhook -> paymentService.handleVerifiedWebhook ->
// order.service.confirmOrderPayment / failOrderPayment):
//  1. happy path: signed captured webhook confirms the right order
//  2. replay: no duplicate confirmation
//  3. invalid signature: rejected
//  4. unknown provider order id: rejected (404)
//  5. amount mismatch: rejected
//  6. currency mismatch: rejected
//  7. cross-order association (known payment id + foreign order id): rejected
//  8. verified FAILED webhook: order cancelled, inventory released

const run = process.env.DATABASE_URL ? describe : describe.skip;

run('razorpay webhook payment flow (integration)', () => {
  let app: Express;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  const webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET || '';
  const created: { orderIds: string[]; productIds: string[]; categoryIds: string[] } = {
    orderIds: [], productIds: [], categoryIds: [],
  };

  beforeAll(async () => {
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    const mod = await import('../../src/app');
    app = mod.createApp();
    const prismaMod = await import('../../src/lib/prisma');
    prisma = prismaMod.prisma;
  });

  afterAll(async () => {
    // Non-destructive cleanup: only rows this test file created.
    for (const id of created.orderIds) {
      await prisma.order.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of created.productIds) {
      await prisma.product.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of created.categoryIds) {
      await prisma.category.delete({ where: { id } }).catch(() => undefined);
    }
  });

  const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // Creates a self-contained pending order exactly the way createOrder does:
  // catalog row, inventory row, reserved stock, PENDING_PAYMENT order with an
  // item snapshot, and a CREATED payment bound to a provider order id.
  const createPendingOrder = async (amountPaise: number) => {
    const stamp = uniq();
    const category = await prisma.category.create({
      data: { slug: 'cat-' + stamp, name: 'Test Category ' + stamp, world: 'sport', description: 'test' },
    });
    created.categoryIds.push(category.id);
    const product = await prisma.product.create({
      data: {
        slug: 'prod-' + stamp, name: 'Test Product ' + stamp, shortDescription: 's', description: 'd',
        categoryId: category.id, pricePaise: amountPaise, status: 'ACTIVE',
        variants: { create: { sku: 'SKU-' + stamp, colorName: 'Black', colorHex: '#000000' } },
      },
    });
    created.productIds.push(product.id);
    const variant = await prisma.productVariant.findFirstOrThrow({ where: { productId: product.id } });
    await prisma.inventory.create({
      data: { variantId: variant.id, availableQty: 10, reservedQty: 0, soldQty: 0 },
    });
    const orderNumber = 'K' + stamp.toUpperCase();
    const order = await prisma.order.create({
      data: {
        orderNumber,
        email: 'webhook-test-' + stamp + '@example.com',
        subtotalPaise: amountPaise, shippingPaise: 0, taxPaise: 0, totalPaise: amountPaise,
        shippingAddress: { firstName: 'Test', lastName: 'User', line1: '1 Test St', city: 'Test', state: 'TS', pincode: '560001', phone: '9876543210' },
        items: { create: {
          variantId: variant.id, productName: product.name, productSlug: product.slug,
          sku: variant.sku, colorName: 'Black', quantity: 1,
          unitPricePaise: amountPaise, lineTotalPaise: amountPaise,
        } },
        statusEvents: { create: { fromStatus: 'NONE', toStatus: 'PENDING_PAYMENT', note: 'Order created' } },
      },
    });
    created.orderIds.push(order.id);
    // Mirror createOrder's inventory reservation.
    await prisma.inventory.update({
      where: { variantId: variant.id },
      data: { availableQty: { decrement: 1 }, reservedQty: { increment: 1 } },
    });
    await prisma.inventoryMovement.create({
      data: { variantId: variant.id, deltaQty: -1, type: 'RESERVE', reference: orderNumber },
    });
    const providerOrderId = 'order_' + stamp;
    const payment = await prisma.payment.create({
      data: {
        orderId: order.id, provider: 'razorpay', providerOrderId,
        method: 'CARD', amountPaise, status: 'CREATED',
      },
    });
    return { order, payment, variant, providerOrderId, orderNumber, amountPaise };
  };

  const webhookBody = (opts: {
    providerPaymentId: string;
    providerOrderId: string;
    amount: number;
    currency?: string;
    status?: string;
    event?: string;
  }) =>
    JSON.stringify({
      event: opts.event ?? 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: opts.providerPaymentId,
            order_id: opts.providerOrderId,
            status: opts.status ?? 'captured',
            amount: opts.amount,
            currency: opts.currency ?? 'INR',
          },
        },
      },
    });

  const sign = (body: string) => createHmac('sha256', webhookSecret).update(body).digest('hex');

  const postWebhook = (body: string, signature: string) =>
    request(app)
      .post('/api/v1/payments/webhook/razorpay')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', signature)
      .send(body);

  it('confirms the correct order on a signed captured webhook (end-to-end)', async () => {
    const t = await createPendingOrder(199900);
    const body = webhookBody({
      providerPaymentId: 'pay_' + uniq(),
      providerOrderId: t.providerOrderId,
      amount: t.amountPaise,
    });
    const res = await postWebhook(body, sign(body));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true });

    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: t.order.id } });
    expect(payment.status).toBe('CAPTURED');
    expect(payment.providerPaymentId).toBeTruthy();
    expect(payment.webhookVerifiedAt).not.toBeNull();

    const order = await prisma.order.findFirstOrThrow({ where: { id: t.order.id } });
    expect(order.status).toBe('CONFIRMED');
    expect(order.paymentStatus).toBe('PAID');
    expect(order.placedAt).not.toBeNull();

    // Reservation converted into a sale, exactly once.
    const inventory = await prisma.inventory.findFirstOrThrow({ where: { variantId: t.variant.id } });
    expect(inventory.availableQty).toBe(9);
    expect(inventory.reservedQty).toBe(0);
    expect(inventory.soldQty).toBe(1);
    const movements = await prisma.inventoryMovement.findMany({
      where: { variantId: t.variant.id, type: 'SALE' },
    });
    expect(movements.length).toBe(1);

    // Shipment record created on confirmation.
    const shipments = await prisma.shipment.findMany({ where: { orderId: t.order.id } });
    expect(shipments.length).toBe(1);

    // Status event trail exists.
    const events = await prisma.orderStatusEvent.findMany({ where: { orderId: t.order.id } });
    expect(events.some((e: { toStatus: string }) => e.toStatus === 'CONFIRMED')).toBe(true);
  });

  it('is idempotent: replaying the same webhook does not duplicate the confirmation', async () => {
    const t = await createPendingOrder(249900);
    const body = webhookBody({
      providerPaymentId: 'pay_' + uniq(),
      providerOrderId: t.providerOrderId,
      amount: t.amountPaise,
    });
    const res1 = await postWebhook(body, sign(body));
    expect(res1.status).toBe(200);
    const res2 = await postWebhook(body, sign(body));
    expect(res2.status).toBe(200);

    const inventory = await prisma.inventory.findFirstOrThrow({ where: { variantId: t.variant.id } });
    expect(inventory.soldQty).toBe(1);
    expect(inventory.reservedQty).toBe(0);
    const shipments = await prisma.shipment.findMany({ where: { orderId: t.order.id } });
    expect(shipments.length).toBe(1);
    const confirmedEvents = await prisma.orderStatusEvent.findMany({
      where: { orderId: t.order.id, toStatus: 'CONFIRMED' },
    });
    expect(confirmedEvents.length).toBe(1);
  });

  it('rejects an invalid signature and leaves the order pending', async () => {
    const t = await createPendingOrder(99900);
    const body = webhookBody({
      providerPaymentId: 'pay_' + uniq(),
      providerOrderId: t.providerOrderId,
      amount: t.amountPaise,
    });
    const res = await postWebhook(body, 'deadbeef' + '0'.repeat(56));
    expect(res.status).toBe(400);
    const order = await prisma.order.findFirstOrThrow({ where: { id: t.order.id } });
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(order.paymentStatus).toBe('PENDING');
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: t.order.id } });
    expect(payment.status).toBe('CREATED');
  });

  it('rejects an unknown provider order id (404) and leaves the order pending', async () => {
    const t = await createPendingOrder(149900);
    const body = webhookBody({
      providerPaymentId: 'pay_' + uniq(),
      providerOrderId: 'order_does_not_exist',
      amount: t.amountPaise,
    });
    const res = await postWebhook(body, sign(body));
    expect(res.status).toBe(404);
    const order = await prisma.order.findFirstOrThrow({ where: { id: t.order.id } });
    expect(order.status).toBe('PENDING_PAYMENT');
  });

  it('rejects an amount mismatch and leaves the order pending', async () => {
    const t = await createPendingOrder(199900);
    const body = webhookBody({
      providerPaymentId: 'pay_' + uniq(),
      providerOrderId: t.providerOrderId,
      amount: 100, // tampered amount
    });
    const res = await postWebhook(body, sign(body));
    expect(res.status).toBe(400);
    const order = await prisma.order.findFirstOrThrow({ where: { id: t.order.id } });
    expect(order.status).toBe('PENDING_PAYMENT');
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: t.order.id } });
    expect(payment.status).toBe('CREATED');
  });

  it('rejects a currency mismatch and leaves the order pending', async () => {
    const t = await createPendingOrder(199900);
    const body = webhookBody({
      providerPaymentId: 'pay_' + uniq(),
      providerOrderId: t.providerOrderId,
      amount: t.amountPaise,
      currency: 'USD',
    });
    const res = await postWebhook(body, sign(body));
    expect(res.status).toBe(400);
    const order = await prisma.order.findFirstOrThrow({ where: { id: t.order.id } });
    expect(order.status).toBe('PENDING_PAYMENT');
  });

  it('rejects a payment id already claimed by another order (cross-order association)', async () => {
    const a = await createPendingOrder(199900);
    const b = await createPendingOrder(199900);
    // First confirm order A with payment id X.
    const bodyA = webhookBody({
      providerPaymentId: 'pay_' + uniq(),
      providerOrderId: a.providerOrderId,
      amount: a.amountPaise,
    });
    const resA = await postWebhook(bodyA, sign(bodyA));
    expect(resA.status).toBe(200);
    const paymentA = await prisma.payment.findFirstOrThrow({ where: { orderId: a.order.id } });
    expect(paymentA.status).toBe('CAPTURED');

    // Then attempt to attach the SAME payment id to order B by pairing it
    // with B's provider order id. Must be rejected.
    const bodyB = webhookBody({
      providerPaymentId: paymentA.providerPaymentId as string,
      providerOrderId: b.providerOrderId,
      amount: b.amountPaise,
    });
    const resB = await postWebhook(bodyB, sign(bodyB));
    expect(resB.status).toBe(400);
    const orderB = await prisma.order.findFirstOrThrow({ where: { id: b.order.id } });
    expect(orderB.status).toBe('PENDING_PAYMENT');
    expect(orderB.paymentStatus).toBe('PENDING');
    const inventoryB = await prisma.inventory.findFirstOrThrow({ where: { variantId: b.variant.id } });
    expect(inventoryB.soldQty).toBe(0);
    expect(inventoryB.reservedQty).toBe(1); // B's reservation untouched
  });

  it('releases reserved inventory on a verified FAILED webhook', async () => {
    const t = await createPendingOrder(89900);
    const body = webhookBody({
      providerPaymentId: 'pay_' + uniq(),
      providerOrderId: t.providerOrderId,
      amount: t.amountPaise,
      status: 'failed',
      event: 'payment.failed',
    });
    const res = await postWebhook(body, sign(body));
    expect(res.status).toBe(200);

    const order = await prisma.order.findFirstOrThrow({ where: { id: t.order.id } });
    expect(order.status).toBe('CANCELLED');
    expect(order.paymentStatus).toBe('FAILED');
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: t.order.id } });
    expect(payment.status).toBe('FAILED');

    // Reservation released back to available.
    const inventory = await prisma.inventory.findFirstOrThrow({ where: { variantId: t.variant.id } });
    expect(inventory.availableQty).toBe(10);
    expect(inventory.reservedQty).toBe(0);
    expect(inventory.soldQty).toBe(0);
    const releases = await prisma.inventoryMovement.findMany({
      where: { variantId: t.variant.id, type: 'RELEASE' },
    });
    expect(releases.length).toBe(1);

    // Replay of the failure event stays idempotent.
    const res2 = await postWebhook(body, sign(body));
    expect(res2.status).toBe(200);
    const releasesAfterReplay = await prisma.inventoryMovement.findMany({
      where: { variantId: t.variant.id, type: 'RELEASE' },
    });
    expect(releasesAfterReplay.length).toBe(1);
  });
});
