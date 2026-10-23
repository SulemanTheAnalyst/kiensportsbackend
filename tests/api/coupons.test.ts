import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createHmac } from 'crypto';
import bcrypt from 'bcryptjs';
import * as authService from '../../src/modules/auth/auth.service';
import type { Express } from 'express';

// Integration tests for the coupon system. Requires a running, migrated
// Postgres (skips without DATABASE_URL). Covers:
//  - Admin CRUD: normalisation, duplicate prevention (409), listing filters.
//  - Calculation: percentage, fixed, maximum-discount cap, minimum order.
//  - Validation: expired / not-started / disabled / exhausted / per-customer
//    limit / product eligibility / non-existent code.
//  - Public listing: only active, public, valid, non-exhausted coupons; no
//    internal fields.
//  - Lifecycle: COD order consumes usage; prepaid success keeps it; FAILED
//    webhook, expiry sweep and admin cancellation each release it.
//  - Order records store the authoritative snapshot; the payment amount
//    equals the discounted backend total.
//
// Rule under test (documented in coupon.service.ts): the minimum order value
// is evaluated against the PRE-DISCOUNT eligible merchandise subtotal.

const run = process.env.DATABASE_URL ? describe : describe.skip;

run('Coupons (integration)', () => {
  let app: Express;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  const webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET || '';
  const created: { orderIds: string[]; productIds: string[]; categoryIds: string[]; userIds: string[]; couponIds: string[] } = {
    orderIds: [], productIds: [], categoryIds: [], userIds: [], couponIds: [],
  };

  beforeAll(async () => {
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    const mod = await import('../../src/app');
    app = mod.createApp();
    const prismaMod = await import('../../src/lib/prisma');
    prisma = prismaMod.prisma;
  });

  afterAll(async () => {
    for (const id of created.couponIds) await prisma.coupon.delete({ where: { id } }).catch(() => undefined);
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

  // Test users are created directly in the database and tokens are minted via
  // the auth service: the register/login endpoints are rate limited per IP
  // (10 per 10 minutes / 10 per hour) which this suite would exhaust. Tokens
  // are the same JWTs the API issues and every request still goes through the
  // real middleware stack, so no production behaviour is bypassed.
  const makeUser = async (opts: { prefix: string; role: 'CUSTOMER' | 'ADMIN' }) => {
    const stamp = uniq();
    const email = opts.prefix + '-' + stamp + '@example.com';
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash('Password12345', 4),
        firstName: 'Test', lastName: 'User', emailVerifiedAt: new Date(),
        roles: { create: { role: { connectOrCreate: { where: { name: opts.role }, create: { name: opts.role } } } } },
      },
    });
    created.userIds.push(user.id);
    const tokens = await authService.issueTokens(user.id, [opts.role]);
    return { email, token: tokens.accessToken as string };
  };

  const registerCustomer = () => makeUser({ prefix: 'cust', role: 'CUSTOMER' });

  // A single admin identity is shared by the whole file.
  let adminJwt = '';
  const adminToken = async () => {
    if (!adminJwt) adminJwt = (await makeUser({ prefix: 'admin', role: 'ADMIN' })).token;
    return adminJwt;
  };

  // Cart adds must share the cart cookie with the later validate call, so the
  // helper returns the cookie-bearing agent.
  const addToCart = async (token: string, variantId: string, quantity = 1) => {
    const agent = request.agent(app);
    const res = await agent.post('/api/v1/cart/items').set('Authorization', 'Bearer ' + token).send({ variantId, quantity });
    expect(res.status).toBe(201);
    return agent;
  };

  const placeOrder = async (
    variantId: string,
    method: 'COD' | 'CARD',
    cust: { email: string; token: string },
    couponCode?: string,
  ) => {
    const agent = request.agent(app);
    const add = await agent.post('/api/v1/cart/items').set('Authorization', 'Bearer ' + cust.token).send({ variantId, quantity: 1 });
    expect(add.status).toBe(201);
    const res = await agent.post('/api/v1/orders').set('Authorization', 'Bearer ' + cust.token).send({
      email: cust.email,
      address: { firstName: 'Cust', lastName: 'Test', line1: '1 Test St', city: 'Bengaluru', state: 'Karnataka', pincode: '560001', phone: '9876543210' },
      paymentMethod: method,
      ...(couponCode ? { couponCode } : {}),
    });
    return { res, agent };
  };

  const createCoupon = async (
    token: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const stamp = uniq();
    const res = await request(app).post('/api/v1/admin/coupons').set('Authorization', 'Bearer ' + token).send({
      code: 'TST' + stamp.slice(-6),
      internalName: 'Test coupon ' + stamp,
      discount: { discountType: 'PERCENT', discountValue: 10 },
      minimumOrderRupees: 0,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      isActive: true,
      isPublic: true,
      firstOrderOnly: false,
      productIds: [],
      displayPriority: 0,
      ...overrides,
    });
    if (res.status === 201) created.couponIds.push(res.body.data.id);
    return res;
  };

  const sign = (body: string) => createHmac('sha256', webhookSecret).update(body).digest('hex');
  const postWebhook = (body: string, signature: string) =>
    request(app).post('/api/v1/payments/webhook/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', signature).send(body);
  const webhookBody = (opts: { providerPaymentId: string; providerOrderId: string; amount: number; status?: string; event?: string }) =>
    JSON.stringify({
      event: opts.event ?? 'payment.captured',
      payload: { payment: { entity: { id: opts.providerPaymentId, order_id: opts.providerOrderId, status: opts.status ?? 'captured', amount: opts.amount, currency: 'INR' } } },
    });

  // ---------------- Admin CRUD ----------------

  it('creates a coupon with a normalised (uppercase, trimmed) code and rejects duplicates with 409', async () => {
    const token = await adminToken();
    const res = await createCoupon(token, { code: '  tsx' + uniq().slice(-6) + '  ' });
    expect(res.status).toBe(201);
    expect(res.body.data.code).toBe(res.body.data.code.trim().toUpperCase());
    expect(res.body.data.code).not.toMatch(/\s/);

    const dup = await request(app).post('/api/v1/admin/coupons').set('Authorization', 'Bearer ' + token).send({
      code: res.body.data.code.toLowerCase(),
      internalName: 'Duplicate',
      discount: { discountType: 'PERCENT', discountValue: 10 },
      minimumOrderRupees: 0,
      startsAt: new Date().toISOString(),
      isActive: true, isPublic: true, firstOrderOnly: false, productIds: [], displayPriority: 0,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('COUPON_DUPLICATE');

    // Unauthenticated and non-admin callers cannot manage coupons.
    const anon = await request(app).post('/api/v1/admin/coupons').send({ code: 'X' });
    expect(anon.status).toBe(401);
    const custToken = (await registerCustomer()).token;
    const cust = await request(app).get('/api/v1/admin/coupons').set('Authorization', 'Bearer ' + custToken);
    expect(cust.status).toBe(403);
  });

  it('lists coupons with search, status filters and usage counts', async () => {
    const token = await adminToken();
    const active = await createCoupon(token, { isPublic: false });
    expect(active.status).toBe(201);
    const disabled = await createCoupon(token, { isActive: false, isPublic: false });
    expect(disabled.status).toBe(201);

    const list = await request(app).get('/api/v1/admin/coupons?limit=60').set('Authorization', 'Bearer ' + token);
    expect(list.status).toBe(200);
    const codes = new Set(list.body.data.map((c: { code: string }) => c.code));
    expect(codes.has(active.body.data.code)).toBe(true);
    expect(list.body.data[0].timesUsed).toBeDefined();

    const search = await request(app).get('/api/v1/admin/coupons?search=' + active.body.data.code).set('Authorization', 'Bearer ' + token);
    expect(search.status).toBe(200);
    expect(search.body.data).toHaveLength(1);

    const disabledList = await request(app).get('/api/v1/admin/coupons?status=DISABLED&search=' + disabled.body.data.code).set('Authorization', 'Bearer ' + token);
    expect(disabledList.status).toBe(200);
    expect(disabledList.body.data).toHaveLength(1);
    expect(disabledList.body.data[0].status).toBe('DISABLED');

    // Enable/disable toggles.
    const off = await request(app).post('/api/v1/admin/coupons/' + active.body.data.id + '/disable').set('Authorization', 'Bearer ' + token);
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);
    const on = await request(app).post('/api/v1/admin/coupons/' + active.body.data.id + '/enable').set('Authorization', 'Bearer ' + token);
    expect(on.status).toBe(200);
    expect(on.body.data.isActive).toBe(true);
  });

  // ---------------- Calculation + validation ----------------

  it('computes a percentage discount on the server and returns authoritative totals', async () => {
    const { variant } = await createProduct(199900); // Rs 1,999
    const token = await adminToken();
    const c = await createCoupon(token, { discount: { discountType: 'PERCENT', discountValue: 10 }, maximumDiscountRupees: 300, minimumOrderRupees: 1499 });
    expect(c.status).toBe(201);

    const cust = await registerCustomer();
    const bag = await addToCart(cust.token, variant.id);
    const v = await bag.post('/api/v1/coupons/validate').set('Authorization', 'Bearer ' + cust.token).send({ code: c.body.data.code });
    expect(v.status).toBe(200);
    // 10% of 199900 = 19990 paise; subtotal 1999 < 2000 free-shipping
    // threshold, so shipping stays 99 rupees.
    expect(v.body.data.coupon.code).toBe(c.body.data.code);
    expect(v.body.data.subtotal).toBe(1999);
    expect(v.body.data.discount).toBe(199); // 19990 paise, displayed in whole rupees
    expect(v.body.data.shipping).toBe(99);
    expect(v.body.data.total).toBe(1898);
  });

  it('caps percentage discounts at the configured maximum', async () => {
    const { variant } = await createProduct(199900);
    const token = await adminToken();
    const c = await createCoupon(token, { discount: { discountType: 'PERCENT', discountValue: 15 }, maximumDiscountRupees: 200, minimumOrderRupees: 1999 });
    expect(c.status).toBe(201);
    const cust = await registerCustomer();
    const bag = await addToCart(cust.token, variant.id);
    const v = await bag.post('/api/v1/coupons/validate').set('Authorization', 'Bearer ' + cust.token).send({ code: c.body.data.code });
    expect(v.status).toBe(200);
    expect(v.body.data.discount).toBe(200); // uncapped would be 299.85 -> capped 200
    expect(v.body.data.total).toBe(1898);
  });

  it('computes fixed-amount discounts correctly', async () => {
    const { variant } = await createProduct(199900);
    const token = await adminToken();
    const c = await createCoupon(token, { discount: { discountType: 'FIXED', discountValue: 200 }, minimumOrderRupees: 1499 });
    expect(c.status).toBe(201);
    const cust = await registerCustomer();
    const bag = await addToCart(cust.token, variant.id);
    const v = await bag.post('/api/v1/coupons/validate').set('Authorization', 'Bearer ' + cust.token).send({ code: c.body.data.code });
    expect(v.status).toBe(200);
    expect(v.body.data.discount).toBe(200);
    expect(v.body.data.total).toBe(1898);
  });

  it('rejects coupons below the pre-discount minimum order value', async () => {
    const { variant } = await createProduct(49900); // Rs 499 < 1499
    const token = await adminToken();
    const c = await createCoupon(token, { minimumOrderRupees: 1499 });
    expect(c.status).toBe(201);
    const cust = await registerCustomer();
    const bag = await addToCart(cust.token, variant.id);
    const v = await bag.post('/api/v1/coupons/validate').set('Authorization', 'Bearer ' + cust.token).send({ code: c.body.data.code });
    expect(v.status).toBe(400);
    expect(v.body.error.code).toBe('MIN_ORDER_NOT_MET');
  });

  it('rejects expired, not-yet-started, disabled and unknown coupons', async () => {
    const { variant } = await createProduct(199900);
    const token = await adminToken();
    const expired = await createCoupon(token, { startsAt: new Date(Date.now() - 86_400_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const scheduled = await createCoupon(token, { startsAt: new Date(Date.now() + 86_400_000).toISOString() });
    const disabled = await createCoupon(token, { isActive: false });
    expect(expired.status).toBe(201);
    expect(scheduled.status).toBe(201);
    expect(disabled.status).toBe(201);

    const cust = await registerCustomer();
    const bag = await addToCart(cust.token, variant.id);
    const e1 = await bag.post('/api/v1/coupons/validate').set('Authorization', 'Bearer ' + cust.token).send({ code: expired.body.data.code });
    expect(e1.status).toBe(400);
    expect(e1.body.error.code).toBe('COUPON_EXPIRED');
    const e2 = await bag.post('/api/v1/coupons/validate').set('Authorization', 'Bearer ' + cust.token).send({ code: scheduled.body.data.code });
    expect(e2.status).toBe(400);
    expect(e2.body.error.code).toBe('COUPON_NOT_STARTED');
    const e3 = await bag.post('/api/v1/coupons/validate').set('Authorization', 'Bearer ' + cust.token).send({ code: disabled.body.data.code });
    expect(e3.status).toBe(400);
    expect(e3.body.error.code).toBe('COUPON_INACTIVE');

    const unknown = await bag.post('/api/v1/coupons/validate').set('Authorization', 'Bearer ' + cust.token).send({ code: 'NOPE' + uniq().slice(-6) });
    expect(unknown.status).toBe(400);
  });

  it('enforces product eligibility: restricted coupons only discount eligible lines', async () => {
    const a = await createProduct(199900);
    const b = await createProduct(49900);
    const token = await adminToken();
    const c = await createCoupon(token, { productIds: [a.product.id], discount: { discountType: 'PERCENT', discountValue: 10 } });
    expect(c.status).toBe(201);

    // Cart with only the ineligible product.
    const cust = await registerCustomer();
    const bag = await addToCart(cust.token, b.variant.id);
    const wrong = await bag.post('/api/v1/coupons/validate').set('Authorization', 'Bearer ' + cust.token).send({ code: c.body.data.code });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('COUPON_NOT_APPLICABLE');

    // Empty bag is rejected too.
    const cust2 = await registerCustomer();
    const empty = await request(app).post('/api/v1/coupons/validate').set('Authorization', 'Bearer ' + cust2.token).send({ code: c.body.data.code });
    expect(empty.status).toBe(400);
  });

  // ---------------- Public listing ----------------

  it('public listing shows only active, public, valid coupons with safe fields', async () => {
    const token = await adminToken();
    const pub = await createCoupon(token, { promoHeadline: 'GET 10% OFF', publicDescription: 'Save on eligible orders.' });
    const priv = await createCoupon(token, { isPublic: false });
    const inactive = await createCoupon(token, { isActive: false, isPublic: true });
    const exhausted = await createCoupon(token, { totalUsageLimit: 1, isPublic: true });
    expect([pub, priv, inactive, exhausted].every((r) => r.status === 201)).toBe(true);
    // Simulate exhaustion.
    await prisma.coupon.update({ where: { id: exhausted.body.data.id }, data: { timesUsed: 1 } });

    const list = await request(app).get('/api/v1/coupons?limit=20');
    expect(list.status).toBe(200);
    const codes = list.body.data.map((c: { code: string }) => c.code);
    expect(codes).toContain(pub.body.data.code);
    expect(codes).not.toContain(priv.body.data.code);
    expect(codes).not.toContain(inactive.body.data.code);
    expect(codes).not.toContain(exhausted.body.data.code);

    // Safe shape only: no internal name, no limits, no admin fields.
    const shown = list.body.data.find((c: { code: string }) => c.code === pub.body.data.code);
    expect(shown.promoHeadline).toBe('GET 10% OFF');
    expect(shown.productIds).toEqual([]);
    expect(shown.internalName).toBeUndefined();
    expect(shown.totalUsageLimit).toBeUndefined();
  });

  // ---------------- Order lifecycle ----------------

  it('applies the coupon to a COD order and records the authoritative snapshot', async () => {
    const { variant } = await createProduct(199900);
    const token = await adminToken();
    const c = await createCoupon(token, { discount: { discountType: 'PERCENT', discountValue: 10 }, minimumOrderRupees: 1499 });
    expect(c.status).toBe(201);
    const cust = await registerCustomer();

    const { res } = await placeOrder(variant.id, 'COD', cust, c.body.data.code);
    expect(res.status).toBe(201);
    const orderNumber = res.body.data.order.orderNumber;
    const order = await prisma.order.findFirstOrThrow({ where: { orderNumber } });
    created.orderIds.push(order.id);

    expect(order.couponCode).toBe(c.body.data.code);
    expect(order.discountPaise).toBe(19990);
    expect(order.subtotalPaise).toBe(199900);
    expect(order.totalPaise).toBe(199900 - 19990 + 9900); // discount + shipping
    expect(order.paymentStatus).toBe('COD_PENDING');

    // Usage consumed exactly once by the reservation.
    const couponRow = await prisma.coupon.findUniqueOrThrow({ where: { id: c.body.data.id } });
    expect(couponRow.timesUsed).toBe(1);
    const redemption = await prisma.couponRedemption.findFirstOrThrow({ where: { orderId: order.id } });
    expect(redemption.discountPaise).toBe(19990);
    expect(redemption.releasedAt).toBeNull();

    // An unknown coupon code can never reduce the total.
    const cust2 = await registerCustomer();
    const bad = await placeOrder(variant.id, 'COD', cust2, 'NOPE' + uniq().slice(-6));
    expect(bad.res.status).toBe(400);
  });

  it('keeps the prepaid payment amount equal to the discounted backend total; success retains usage', async () => {
    const { variant } = await createProduct(199900);
    const token = await adminToken();
    const c = await createCoupon(token, { discount: { discountType: 'FIXED', discountValue: 200 } });
    expect(c.status).toBe(201);
    const cust = await registerCustomer();

    const { res } = await placeOrder(variant.id, 'CARD', cust, c.body.data.code);
    expect(res.status).toBe(201);
    const order = await prisma.order.findFirstOrThrow({ where: { orderNumber: res.body.data.order.orderNumber } });
    created.orderIds.push(order.id);
    expect(order.totalPaise).toBe(199900 - 20000 + 9900);

    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(payment.amountPaise).toBe(order.totalPaise); // Razorpay amount = verified total

    const body = webhookBody({ providerPaymentId: 'pay_' + uniq(), providerOrderId: payment.providerOrderId, amount: payment.amountPaise });
    const ok = await postWebhook(body, sign(body));
    expect(ok.status).toBe(200);

    const confirmed = await prisma.order.findFirstOrThrow({ where: { id: order.id } });
    expect(confirmed.paymentStatus).toBe('PAID');
    const couponRow = await prisma.coupon.findUniqueOrThrow({ where: { id: c.body.data.id } });
    expect(couponRow.timesUsed).toBe(1); // success keeps the redemption
  });

  it('releases coupon usage on a FAILED webhook and on the expiry sweep', async () => {
    const { variant } = await createProduct(199900);
    const token = await adminToken();
    const c = await createCoupon(token, { discount: { discountType: 'PERCENT', discountValue: 10 } });
    expect(c.status).toBe(201);
    const cust = await registerCustomer();

    const { res } = await placeOrder(variant.id, 'CARD', cust, c.body.data.code);
    expect(res.status).toBe(201);
    const order = await prisma.order.findFirstOrThrow({ where: { orderNumber: res.body.data.order.orderNumber } });
    created.orderIds.push(order.id);
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c.body.data.id } })).timesUsed).toBe(1);

    const failBody = webhookBody({ providerPaymentId: 'pay_' + uniq(), providerOrderId: payment.providerOrderId, amount: payment.amountPaise, status: 'failed', event: 'payment.failed' });
    const fail = await postWebhook(failBody, sign(failBody));
    expect(fail.status).toBe(200);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c.body.data.id } })).timesUsed).toBe(0);
    const released = await prisma.couponRedemption.findFirstOrThrow({ where: { orderId: order.id } });
    expect(released.releasedAt).not.toBeNull();

    // Expiry sweep path: another attempt, then backdate + sweep.
    const cust2 = await registerCustomer();
    const second = await placeOrder(variant.id, 'CARD', cust2, c.body.data.code);
    expect(second.res.status).toBe(201);
    const order2 = await prisma.order.findFirstOrThrow({ where: { orderNumber: second.res.body.data.order.orderNumber } });
    created.orderIds.push(order2.id);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c.body.data.id } })).timesUsed).toBe(1);

    await prisma.order.update({ where: { id: order2.id }, data: { createdAt: new Date(Date.now() - 3 * 60 * 60_000) } });
    const sweep = await request(app).post('/api/v1/admin/orders/expire-pending').set('Authorization', 'Bearer ' + token).send({});
    expect(sweep.status).toBe(200);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c.body.data.id } })).timesUsed).toBe(0);
  });

  it('releases coupon usage when an admin cancels an order', async () => {
    const { variant } = await createProduct(199900);
    const token = await adminToken();
    const c = await createCoupon(token, { discount: { discountType: 'PERCENT', discountValue: 10 } });
    expect(c.status).toBe(201);
    const cust = await registerCustomer();

    const { res } = await placeOrder(variant.id, 'COD', cust, c.body.data.code);
    expect(res.status).toBe(201);
    const order = await prisma.order.findFirstOrThrow({ where: { orderNumber: res.body.data.order.orderNumber } });
    created.orderIds.push(order.id);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c.body.data.id } })).timesUsed).toBe(1);

    const cancel = await request(app).post('/api/v1/admin/orders/' + order.orderNumber + '/transition').set('Authorization', 'Bearer ' + token).send({ toStatus: 'CANCELLED' });
    expect(cancel.status).toBe(200);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c.body.data.id } })).timesUsed).toBe(0);
  });

  it('enforces total and per-customer usage limits at order creation', async () => {
    const { variant } = await createProduct(199900);
    const token = await adminToken();
    const total = await createCoupon(token, { totalUsageLimit: 1, discount: { discountType: 'PERCENT', discountValue: 10 } });
    const perCustomer = await createCoupon(token, { perCustomerUsageLimit: 1, discount: { discountType: 'PERCENT', discountValue: 10 } });
    expect(total.status).toBe(201);
    expect(perCustomer.status).toBe(201);

    // Total limit: first order consumes the single slot.
    const c1 = await registerCustomer();
    const first = await placeOrder(variant.id, 'COD', c1, total.body.data.code);
    expect(first.res.status).toBe(201);
    const o1 = await prisma.order.findFirstOrThrow({ where: { orderNumber: first.res.body.data.order.orderNumber } });
    created.orderIds.push(o1.id);

    const c2 = await registerCustomer();
    const second = await placeOrder(variant.id, 'COD', c2, total.body.data.code);
    expect(second.res.status).toBe(400);
    expect(second.res.body.error.code).toBe('COUPON_EXHAUSTED');

    // Per-customer limit: the same customer cannot use it twice.
    const c3 = await registerCustomer();
    const a = await placeOrder(variant.id, 'COD', c3, perCustomer.body.data.code);
    expect(a.res.status).toBe(201);
    const oa = await prisma.order.findFirstOrThrow({ where: { orderNumber: a.res.body.data.order.orderNumber } });
    created.orderIds.push(oa.id);
    const again = await placeOrder(variant.id, 'COD', c3, perCustomer.body.data.code);
    expect(again.res.status).toBe(400);
    expect(again.res.body.error.code).toBe('COUPON_CUSTOMER_LIMIT');
    // A different customer still can.
    const c4 = await registerCustomer();
    const okOther = await placeOrder(variant.id, 'COD', c4, perCustomer.body.data.code);
    expect(okOther.res.status).toBe(201);
    const o4 = await prisma.order.findFirstOrThrow({ where: { orderNumber: okOther.res.body.data.order.orderNumber } });
    created.orderIds.push(o4.id);
  });

  it('exposes coupon usage history to admins', async () => {
    const token = await adminToken();
    const c = await createCoupon(token, { discount: { discountType: 'PERCENT', discountValue: 10 } });
    expect(c.status).toBe(201);

    const { variant } = await createProduct(199900);
    const cust = await registerCustomer();
    const { res } = await placeOrder(variant.id, 'COD', cust, c.body.data.code);
    expect(res.status).toBe(201);
    const order = await prisma.order.findFirstOrThrow({ where: { orderNumber: res.body.data.order.orderNumber } });
    created.orderIds.push(order.id);

    const usage = await request(app).get('/api/v1/admin/coupons/' + c.body.data.id + '/usage').set('Authorization', 'Bearer ' + token);
    expect(usage.status).toBe(200);
    expect(usage.body.data.length).toBeGreaterThanOrEqual(1);
    const entry = usage.body.data.find((u: { orderId: string }) => u.orderId === order.id);
    expect(entry).toBeDefined();
    expect(entry.discountPaise).toBe(19990);

    const report = await request(app).get('/api/v1/admin/coupons/' + c.body.data.id + '/report').set('Authorization', 'Bearer ' + token);
    expect(report.status).toBe(200);
    expect(report.body.data.timesUsed).toBeGreaterThanOrEqual(1);
  });
});
