import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createHmac } from 'crypto';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';

// Integration test: requires a running Postgres and a migrated database.
// Skips automatically when DATABASE_URL is not configured. No Razorpay
// credentials and no real payments: webhooks are simulated by signing the
// raw body with PAYMENT_WEBHOOK_SECRET exactly like Razorpay does.
//
// Lifecycle coverage (COD + prepaid + expiry + notifications):
//  1. COD checkout succeeds with no transient invalid-method error; the
//     order is CONFIRMED / COD_PENDING and is never falsely marked PAID.
//  2. COD fulfilment transitions work unpaid; collect-cod is the only way
//     the order becomes PAID (and converts the reservation into a sale).
//  3. A prepaid attempt is PENDING_PAYMENT (not a confirmed order) until a
//     verified webhook confirms it; duplicate webhooks do not duplicate
//     confirmations or notifications.
//  4. A verified FAILED webhook cancels the order and releases inventory.
//  5. Expired attempts release inventory; a late captured webhook can never
//     resurrect the expired order (payment recorded, flagged for refund).
//  6. Cart-add notifications fire once per variant/cooldown, and guests
//     never get an invented identity.

const run = process.env.DATABASE_URL ? describe : describe.skip;

run('COD / prepaid payment lifecycle (integration)', () => {
  let app: Express;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  const webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET || '';
  const created: { orderIds: string[]; productIds: string[]; categoryIds: string[]; userIds: string[] } = {
    orderIds: [], productIds: [], categoryIds: [], userIds: [],
  };

  beforeAll(async () => {
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    const mod = await import('../../src/app');
    app = mod.createApp();
    const prismaMod = await import('../../src/lib/prisma');
    prisma = prismaMod.prisma;
  });

  afterAll(async () => {
    for (const id of created.orderIds) await prisma.order.delete({ where: { id } }).catch(() => undefined);
    for (const id of created.productIds) await prisma.product.delete({ where: { id } }).catch(() => undefined);
    for (const id of created.categoryIds) await prisma.category.delete({ where: { id } }).catch(() => undefined);
    for (const id of created.userIds) await prisma.user.delete({ where: { id } }).catch(() => undefined);
  });

  const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const createProduct = async (pricePaise: number) => {
    const stamp = uniq();
    const category = await prisma.category.create({
      data: { slug: 'cat-' + stamp, name: 'Cat ' + stamp, world: 'sport', description: 't' },
    });
    created.categoryIds.push(category.id);
    const product = await prisma.product.create({
      data: {
        slug: 'prod-' + stamp, name: 'Prod ' + stamp, shortDescription: 's', description: 'd',
        categoryId: category.id, pricePaise, status: 'ACTIVE',
        variants: { create: { sku: 'SKU-' + stamp, colorName: 'Black', colorHex: '#000000', size: 'M' } },
      },
    });
    created.productIds.push(product.id);
    const variant = await prisma.productVariant.findFirstOrThrow({ where: { productId: product.id } });
    await prisma.inventory.create({ data: { variantId: variant.id, availableQty: 10, reservedQty: 0, soldQty: 0 } });
    return { product, variant };
  };

  const registerCustomer = async () => {
    const stamp = uniq();
    const email = 'cust-' + stamp + '@example.com';
    const reg = await request(app).post('/api/v1/auth/register').send({
      email, password: 'Password123', firstName: 'Cust', lastName: 'Test',
    });
    expect(reg.status).toBe(201);
    const user = await prisma.user.findUnique({ where: { email } });
    created.userIds.push(user.id);
    return { email, token: reg.body.data.accessToken as string };
  };

  const adminToken = async () => {
    const stamp = uniq();
    const email = 'admin-' + stamp + '@example.com';
    const password = 'Password12345';
    const user = await prisma.user.create({
      data: {
        email, passwordHash: await bcrypt.hash(password, 4),
        firstName: 'Admin', lastName: 'Test', emailVerifiedAt: new Date(),
        roles: { create: { role: { connect: { name: 'ADMIN' } } } },
      },
    });
    created.userIds.push(user.id);
    const login = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(login.status).toBe(200);
    return login.body.data.accessToken as string;
  };

  const placeOrder = async (variantId: string, method: 'COD' | 'CARD', cust: { email: string; token: string }) => {
    const agent = request.agent(app);
    const add = await agent.post('/api/v1/cart/items').set('Authorization', 'Bearer ' + cust.token).send({ variantId, quantity: 1 });
    expect(add.status).toBe(201);
    const res = await agent.post('/api/v1/orders').set('Authorization', 'Bearer ' + cust.token).send({
      email: cust.email,
      address: { firstName: 'Cust', lastName: 'Test', line1: '1 Test St', city: 'Bengaluru', state: 'Karnataka', pincode: '560001', phone: '9876543210' },
      paymentMethod: method,
    });
    return { res, agent };
  };

  const webhookBody = (opts: { providerPaymentId: string; providerOrderId: string; amount: number; status?: string; event?: string }) =>
    JSON.stringify({
      event: opts.event ?? 'payment.captured',
      payload: { payment: { entity: { id: opts.providerPaymentId, order_id: opts.providerOrderId, status: opts.status ?? 'captured', amount: opts.amount, currency: 'INR' } } },
    });
  const sign = (body: string) => createHmac('sha256', webhookSecret).update(body).digest('hex');
  const postWebhook = (body: string, signature: string) =>
    request(app).post('/api/v1/payments/webhook/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', signature).send(body);

  const outboxCount = (type: string, dedupeKey: string) =>
    prisma.notificationOutbox.count({ where: { type, dedupeKey } });

  // ---------------- COD ----------------

  it('creates a valid COD order without any payment-gateway error, never marked PAID', async () => {
    const { variant } = await createProduct(49900);
    const cust = await registerCustomer();
    const { res } = await placeOrder(variant.id, 'COD', cust);
    expect(res.status).toBe(201);
    const order = res.body.data.order;
    expect(order.status).toBe('CONFIRMED');
    expect(order.paymentStatus).toBe('COD_PENDING');
    expect(order.paymentStatus).not.toBe('PAID');
    expect(res.body.data.payment.method).toBe('COD');
    expect(res.body.data.payment.checkoutPayload.mode).toBe('cod');

    const row = await prisma.order.findFirstOrThrow({ where: { orderNumber: order.orderNumber }, include: { payments: true, items: true } });
    created.orderIds.push(row.id);
    expect(row.status).toBe('CONFIRMED');
    expect(row.paymentStatus).toBe('COD_PENDING');
    expect(row.placedAt).not.toBeNull();
    const payment = row.payments.find((p: { method: string }) => p.method === 'COD');
    expect(payment.status).toBe('COD_PENDING');
    expect(payment.provider).toBe('cod');

    // Inventory reserved for the COD order.
    const inv = await prisma.inventory.findFirstOrThrow({ where: { variantId: variant.id } });
    expect(inv.availableQty).toBe(9);
    expect(inv.reservedQty).toBe(1);
    expect(inv.soldQty).toBe(0);

    // Exactly one order-created notification.
    expect(await outboxCount('ORDER_CREATED', 'ORDER_CREATED:' + row.id)).toBe(1);
  });

  it('allows COD fulfilment unpaid and marks PAID only on cash collection', async () => {
    const { variant } = await createProduct(49900);
    const cust = await registerCustomer();
    const { res } = await placeOrder(variant.id, 'COD', cust);
    expect(res.status).toBe(201);
    const orderNumber = res.body.data.order.orderNumber;
    const orderRow = await prisma.order.findFirstOrThrow({ where: { orderNumber } });
    created.orderIds.push(orderRow.id);
    const admin = 'Bearer ' + (await adminToken());

    // Fulfilment transitions succeed while payment is still COD_PENDING.
    for (const to of ['PROCESSING', 'SHIPPED', 'DELIVERED']) {
      const t = await request(app).post('/api/v1/admin/orders/' + orderNumber + '/transition').set('Authorization', admin).send({ toStatus: to });
      expect(t.status).toBe(200);
      expect(t.body.data.status).toBe(to);
    }
    const still = await prisma.order.findFirstOrThrow({ where: { id: orderRow.id } });
    expect(still.paymentStatus).toBe('COD_PENDING'); // dispatch never fakes payment

    // Collect the cash: the only path to PAID.
    const collect = await request(app).post('/api/v1/admin/orders/' + orderNumber + '/collect-cod').set('Authorization', admin).send({});
    expect(collect.status).toBe(200);
    expect(collect.body.data.paymentStatus).toBe('PAID');
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: orderRow.id, method: 'COD' } });
    expect(payment.status).toBe('COD_COLLECTED');
    const inv = await prisma.inventory.findFirstOrThrow({ where: { variantId: variant.id } });
    expect(inv.soldQty).toBe(1);
    expect(inv.reservedQty).toBe(0);
    expect(inv.availableQty).toBe(9);
    expect(await outboxCount('COD_COLLECTED', 'COD_COLLECTED:' + orderRow.id)).toBe(1);

    // Double collection is refused.
    const again = await request(app).post('/api/v1/admin/orders/' + orderNumber + '/collect-cod').set('Authorization', admin).send({});
    expect(again.status).toBe(400);
  });

  it('blocks fulfilment of an unpaid prepaid attempt and cancelled orders, with clear reasons', async () => {
    const { variant } = await createProduct(199900);
    const cust = await registerCustomer();
    const { res } = await placeOrder(variant.id, 'CARD', cust);
    expect(res.status).toBe(201);
    const orderNumber = res.body.data.order.orderNumber;
    const orderRow = await prisma.order.findFirstOrThrow({ where: { orderNumber } });
    created.orderIds.push(orderRow.id);
    const admin = 'Bearer ' + (await adminToken());

    const t = await request(app).post('/api/v1/admin/orders/' + orderNumber + '/transition').set('Authorization', admin).send({ toStatus: 'PROCESSING' });
    expect(t.status).toBe(400);
    expect(String(t.body.error.message)).toContain('awaiting payment');

    const cancel = await request(app).post('/api/v1/admin/orders/' + orderNumber + '/transition').set('Authorization', admin).send({ toStatus: 'CANCELLED' });
    expect(cancel.status).toBe(200);

    const after = await request(app).post('/api/v1/admin/orders/' + orderNumber + '/transition').set('Authorization', admin).send({ toStatus: 'PROCESSING' });
    expect(after.status).toBe(400);
    expect(String(after.body.error.message)).toContain('no longer be transitioned');
  });

  // ---------------- Prepaid lifecycle ----------------

  it('keeps a prepaid attempt unconfirmed until a verified webhook; no duplicate effects', async () => {
    const { variant } = await createProduct(199900);
    const cust = await registerCustomer();
    const { res } = await placeOrder(variant.id, 'CARD', cust);
    expect(res.status).toBe(201);
    const orderNumber = res.body.data.order.orderNumber;
    const orderRow = await prisma.order.findFirstOrThrow({ where: { orderNumber } });
    created.orderIds.push(orderRow.id);

    // The attempt is NOT a confirmed business order and has no notification yet.
    expect(orderRow.status).toBe('PENDING_PAYMENT');
    expect(orderRow.paymentStatus).toBe('PENDING');
    expect(await outboxCount('ORDER_CREATED', 'ORDER_CREATED:' + orderRow.id)).toBe(0);

    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: orderRow.id } });
    const body = webhookBody({ providerPaymentId: 'pay_' + uniq(), providerOrderId: payment.providerOrderId, amount: payment.amountPaise });
    const ok = await postWebhook(body, sign(body));
    expect(ok.status).toBe(200);

    const confirmed = await prisma.order.findFirstOrThrow({ where: { id: orderRow.id } });
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.paymentStatus).toBe('PAID');
    const inv = await prisma.inventory.findFirstOrThrow({ where: { variantId: variant.id } });
    expect(inv.soldQty).toBe(1);
    expect(inv.reservedQty).toBe(0);

    // Notifications: exactly one each.
    expect(await outboxCount('ORDER_CREATED', 'ORDER_CREATED:' + orderRow.id)).toBe(1);
    expect(await outboxCount('PAYMENT_SUCCEEDED', 'PAYMENT_SUCCEEDED:' + payment.id)).toBe(1);

    // Duplicate webhook: nothing duplicates.
    await postWebhook(body, sign(body));
    const inv2 = await prisma.inventory.findFirstOrThrow({ where: { variantId: variant.id } });
    expect(inv2.soldQty).toBe(1);
    expect(await outboxCount('ORDER_CREATED', 'ORDER_CREATED:' + orderRow.id)).toBe(1);
    expect(await outboxCount('PAYMENT_SUCCEEDED', 'PAYMENT_SUCCEEDED:' + payment.id)).toBe(1);
    const shipments = await prisma.shipment.count({ where: { orderId: orderRow.id } });
    expect(shipments).toBe(1);
  });

  it('cancels the order and releases inventory on a verified FAILED webhook', async () => {
    const { variant } = await createProduct(89900);
    const cust = await registerCustomer();
    const { res } = await placeOrder(variant.id, 'CARD', cust);
    expect(res.status).toBe(201);
    const orderNumber = res.body.data.order.orderNumber;
    const orderRow = await prisma.order.findFirstOrThrow({ where: { orderNumber } });
    created.orderIds.push(orderRow.id);
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: orderRow.id } });

    const body = webhookBody({ providerPaymentId: 'pay_' + uniq(), providerOrderId: payment.providerOrderId, amount: payment.amountPaise, status: 'failed', event: 'payment.failed' });
    const ok = await postWebhook(body, sign(body));
    expect(ok.status).toBe(200);

    const order = await prisma.order.findFirstOrThrow({ where: { id: orderRow.id } });
    expect(order.status).toBe('CANCELLED');
    expect(order.paymentStatus).toBe('FAILED');
    const inv = await prisma.inventory.findFirstOrThrow({ where: { variantId: variant.id } });
    expect(inv.availableQty).toBe(10);
    expect(inv.reservedQty).toBe(0);
    expect(inv.soldQty).toBe(0);
    expect(await outboxCount('PAYMENT_FAILED', 'PAYMENT_FAILED:' + orderRow.id)).toBe(1);
    // No order-created notification was ever sent for the failed attempt.
    expect(await outboxCount('ORDER_CREATED', 'ORDER_CREATED:' + orderRow.id)).toBe(0);
  });

  // ---------------- Expiry + late payment ----------------

  it('expires stale attempts via the admin sweep and never resurrects them on late capture', async () => {
    const { variant } = await createProduct(299900);
    const cust = await registerCustomer();
    const { res } = await placeOrder(variant.id, 'CARD', cust);
    expect(res.status).toBe(201);
    const orderNumber = res.body.data.order.orderNumber;
    const orderRow = await prisma.order.findFirstOrThrow({ where: { orderNumber } });
    created.orderIds.push(orderRow.id);
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: orderRow.id } });
    const admin = 'Bearer ' + (await adminToken());

    // Backdate the attempt beyond the TTL (default 60 minutes).
    await prisma.order.update({ where: { id: orderRow.id }, data: { createdAt: new Date(Date.now() - 3 * 60 * 60_000) } });

    const sweep = await request(app).post('/api/v1/admin/orders/expire-pending').set('Authorization', admin).send({});
    expect(sweep.status).toBe(200);
    expect(sweep.body.data.expired).toBeGreaterThanOrEqual(1);

    const expired = await prisma.order.findFirstOrThrow({ where: { id: orderRow.id } });
    expect(expired.status).toBe('CANCELLED');
    expect(expired.paymentStatus).toBe('FAILED');
    const payRow = await prisma.payment.findFirstOrThrow({ where: { id: payment.id } });
    expect(payRow.status).toBe('EXPIRED');
    const inv = await prisma.inventory.findFirstOrThrow({ where: { variantId: variant.id } });
    expect(inv.availableQty).toBe(10);
    expect(inv.reservedQty).toBe(0);
    expect(await outboxCount('PAYMENT_EXPIRED', 'PAYMENT_EXPIRED:' + orderRow.id)).toBe(1);

    // A late captured webhook must NOT confirm the expired order.
    const body = webhookBody({ providerPaymentId: 'pay_' + uniq(), providerOrderId: payment.providerOrderId, amount: payment.amountPaise });
    const late = await postWebhook(body, sign(body));
    expect(late.status).toBe(200);
    const after = await prisma.order.findFirstOrThrow({ where: { id: orderRow.id } });
    expect(after.status).toBe('CANCELLED');
    expect(after.paymentStatus).toBe('FAILED');
    const payAfter = await prisma.payment.findFirstOrThrow({ where: { id: payment.id } });
    expect(payAfter.status).toBe('CAPTURED'); // money recorded for reconciliation
    const invAfter = await prisma.inventory.findFirstOrThrow({ where: { variantId: variant.id } });
    expect(invAfter.soldQty).toBe(0); // inventory never re-deducted
    expect(invAfter.availableQty).toBe(10);
    expect(await outboxCount('PAYMENT_LATE', 'PAYMENT_LATE:' + payment.id)).toBe(1);
    expect(await outboxCount('ORDER_CREATED', 'ORDER_CREATED:' + orderRow.id)).toBe(0);

    // Expiry sweep is idempotent (no second expiration notification).
    const sweep2 = await request(app).post('/api/v1/admin/orders/expire-pending').set('Authorization', admin).send({});
    expect(sweep2.status).toBe(200);
    expect(await outboxCount('PAYMENT_EXPIRED', 'PAYMENT_EXPIRED:' + orderRow.id)).toBe(1);
  });

  it('expires a stale attempt lazily on the public status poll', async () => {
    const { variant } = await createProduct(159900);
    const cust = await registerCustomer();
    const { res } = await placeOrder(variant.id, 'CARD', cust);
    expect(res.status).toBe(201);
    const orderNumber = res.body.data.order.orderNumber;
    const orderRow = await prisma.order.findFirstOrThrow({ where: { orderNumber } });
    created.orderIds.push(orderRow.id);
    await prisma.order.update({ where: { id: orderRow.id }, data: { createdAt: new Date(Date.now() - 3 * 60 * 60_000) } });

    const poll = await request(app).get('/api/v1/orders/' + orderNumber + '/status');
    expect(poll.status).toBe(200);
    expect(poll.body.data.status).toBe('CANCELLED');
    expect(poll.body.data.paymentStatus).toBe('FAILED');
  });

  // ---------------- Cart activity notifications ----------------

  it('records cart activity once per first add, without inventing guest identity', async () => {
    const { product, variant } = await createProduct(14900);

    // Guest: no contact details supplied - only the cart id is known.
    const guest = request.agent(app);
    const add1 = await guest.post('/api/v1/cart/items').send({ variantId: variant.id, quantity: 1 });
    expect(add1.status).toBe(201);
    const cartId = add1.body.data.id as string;

    const rows = await prisma.notificationOutbox.findMany({
      where: { type: 'CART_ACTIVITY', dedupeKey: { startsWith: 'CART_ACTIVITY:' + cartId + ':' + variant.id + ':' } },
    });
    expect(rows.length).toBe(1);
    const payload = rows[0].payload;
    expect(payload.customerName).toBeNull();
    expect(payload.customerPhone).toBeNull();
    expect(payload.customerEmail).toBeNull();
    expect(payload.cartOrSessionId).toBe(cartId);
    expect(payload.productName).toBe(product.name);
    expect(payload.quantity).toBe(1);

    // Quantity bump on the same item: no new notification.
    const add2 = await guest.post('/api/v1/cart/items').send({ variantId: variant.id, quantity: 1 });
    expect(add2.status).toBe(201);
    const rows2 = await prisma.notificationOutbox.findMany({
      where: { type: 'CART_ACTIVITY', dedupeKey: { startsWith: 'CART_ACTIVITY:' + cartId + ':' + variant.id + ':' } },
    });
    expect(rows2.length).toBe(1);

    // Authenticated user: legitimate account contact details are attached.
    const cust = await registerCustomer();
    const authAgent = request.agent(app);
    const add3 = await authAgent.post('/api/v1/cart/items').set('Authorization', 'Bearer ' + cust.token).send({ variantId: variant.id, quantity: 2 });
    expect(add3.status).toBe(201);
    const authCartId = add3.body.data.id as string;
    const authRows = await prisma.notificationOutbox.findMany({
      where: { type: 'CART_ACTIVITY', dedupeKey: { startsWith: 'CART_ACTIVITY:' + authCartId + ':' + variant.id + ':' } },
    });
    expect(authRows.length).toBe(1);
    expect(authRows[0].payload.customerEmail).toBe(cust.email);
    expect(authRows[0].payload.customerName).toContain('Cust');
  });
});
