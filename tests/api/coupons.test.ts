import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createHmac } from 'crypto';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';

// Integration tests for the coupon engine (validation, calculation, limits,
// lifecycle integration with COD / prepaid orders, admin CRUD, public
// listing). Requires a running Postgres and a migrated database; skips
// automatically when DATABASE_URL is not configured.
//
// Documented calculation contract:
//  - discounts are computed in exact paise from server-side prices,
//  - capped by the optional maximum, then floored to a whole rupee,
//  - the minimum order value is evaluated against the PRE-discount subtotal,
//  - a CouponUsage row (ACTIVE) is created inside the order transaction
//    under a FOR UPDATE lock on the coupon row, and RELEASED when the
//    payment fails, the attempt expires or the order is cancelled.

const run = process.env.DATABASE_URL ? describe : describe.skip;

run('Coupon engine (integration)', () => {
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
    // Orders first (CouponUsage rows cascade with their order).
    for (const id of created.orderIds) await prisma.order.delete({ where: { id } }).catch(() => undefined);
    for (const id of created.couponIds) await prisma.coupon.delete({ where: { id } }).catch(() => undefined);
    for (const id of created.productIds) await prisma.product.delete({ where: { id } }).catch(() => undefined);
    for (const id of created.categoryIds) await prisma.category.delete({ where: { id } }).catch(() => undefined);
    for (const id of created.userIds) await prisma.user.delete({ where: { id } }).catch(() => undefined);
    // Restore default business settings for later test files.
    await prisma.businessSettings.delete({ where: { id: 'singleton' } }).catch(() => undefined);
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
    return { email, token: reg.body.data.accessToken as string, userId: user.id };
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

  interface CouponSpec {
    code?: string;
    discountType: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FREE_SHIPPING';
    discountValue: number; // percent points, or RUPEES for fixed
    minimumOrderRupees?: number;
    maximumDiscountRupees?: number;
    isPublic?: boolean;
    totalUsageLimit?: number;
    perCustomerUsageLimit?: number;
    firstOrderOnly?: boolean;
    startsAt?: string;
    expiresAt?: string;
    isActive?: boolean;
    productIds?: string[];
  }

  const adminCreateCoupon = async (admin: string, spec: CouponSpec) => {
    const res = await request(app).post('/api/v1/admin/coupons').set('Authorization', 'Bearer ' + admin).send({
      code: spec.code ?? 'T_' + uniq(),
      internalName: 'Test coupon',
      discountType: spec.discountType,
      discountValue: spec.discountValue,
      ...(spec.minimumOrderRupees !== undefined ? { minimumOrderRupees: spec.minimumOrderRupees } : {}),
      ...(spec.maximumDiscountRupees !== undefined ? { maximumDiscountRupees: spec.maximumDiscountRupees } : {}),
      ...(spec.isPublic !== undefined ? { isPublic: spec.isPublic } : {}),
      ...(spec.totalUsageLimit !== undefined ? { totalUsageLimit: spec.totalUsageLimit } : {}),
      ...(spec.perCustomerUsageLimit !== undefined ? { perCustomerUsageLimit: spec.perCustomerUsageLimit } : {}),
      ...(spec.firstOrderOnly !== undefined ? { firstOrderOnly: spec.firstOrderOnly } : {}),
      ...(spec.startsAt ? { startsAt: spec.startsAt } : {}),
      ...(spec.expiresAt ? { expiresAt: spec.expiresAt } : {}),
      ...(spec.isActive !== undefined ? { isActive: spec.isActive } : {}),
      ...(spec.productIds ? { productIds: spec.productIds } : {}),
    });
    if (res.status === 201) created.couponIds.push(res.body.data.id);
    return res;
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
    if (res.status === 201) {
      const row = await prisma.order.findFirstOrThrow({ where: { orderNumber: res.body.data.order.orderNumber } });
      created.orderIds.push(row.id);
    }
    return res;
  };

  const quoteWithCoupon = async (token: string | null, variantId: string, coupon?: string) => {
    const agent = request.agent(app);
    const add = await agent.post('/api/v1/cart/items')
      .set('Authorization', token ? 'Bearer ' + token : '')
      .send({ variantId, quantity: 1 });
    expect(add.status).toBe(201);
    const q = await agent.get('/api/v1/cart/quote' + (coupon ? '?coupon=' + encodeURIComponent(coupon) : ''))
      .set('Authorization', token ? 'Bearer ' + token : '');
    return q;
  };

  const webhookBody = (opts: { providerPaymentId: string; providerOrderId: string; amount: number; status?: string; event?: string }) =>
    JSON.stringify({
      event: opts.event ?? 'payment.captured',
      payload: { payment: { entity: { id: opts.providerPaymentId, order_id: opts.providerOrderId, status: opts.status ?? 'captured', amount: opts.amount, currency: 'INR' } } },
    });
  const sign = (body: string) => createHmac('sha256', webhookSecret).update(body).digest('hex');
  const postWebhook = (body: string, signature: string) =>
    request(app).post('/api/v1/payments/webhook/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', signature).send(body);

  const usageRow = async (orderId: string) =>
    prisma.couponUsage.findFirst({ where: { orderId } });

  // ---------------- Calculation rules ----------------

  it('calculates a 10% percentage discount from server-side prices and floors to whole rupees', async () => {
    const admin = await adminToken();
    const { product, variant } = await createProduct(199900); // ₹1,999
    await adminCreateCoupon(admin, {
      code: 'PCT10', discountType: 'PERCENTAGE', discountValue: 10,
      minimumOrderRupees: 1499, maximumDiscountRupees: 300,
    });
    const cust = await registerCustomer();

    const q = await quoteWithCoupon(cust.token, variant.id, 'pct10'); // case-insensitive
    expect(q.status).toBe(200);
    expect(q.body.data.subtotal).toBe(1999);
    expect(q.body.data.discount).toBe(199); // 10% of ₹1,999 = ₹199.90 → floored to ₹199
    expect(q.body.data.shipping).toBe(99);  // below the ₹2,000 free-shipping threshold
    expect(q.body.data.total).toBe(1999 - 199 + 99);
    expect(q.body.data.coupon.code).toBe('PCT10');
    void product;
  });

  it('calculates a fixed-amount discount', async () => {
    const admin = await adminToken();
    const { variant } = await createProduct(199900);
    await adminCreateCoupon(admin, { code: 'FLAT200', discountType: 'FIXED_AMOUNT', discountValue: 200, minimumOrderRupees: 1499 });
    const cust = await registerCustomer();

    const q = await quoteWithCoupon(cust.token, variant.id, 'FLAT200');
    expect(q.status).toBe(200);
    expect(q.body.data.discount).toBe(200);
    expect(q.body.data.total).toBe(1999 - 200 + 99);
  });

  it('enforces the maximum discount cap', async () => {
    const admin = await adminToken();
    const { variant } = await createProduct(199900);
    // 15% of ₹1,999 = ₹299.85 uncapped; capped at ₹200.
    await adminCreateCoupon(admin, { code: 'CAP200', discountType: 'PERCENTAGE', discountValue: 15, maximumDiscountRupees: 200 });
    const cust = await registerCustomer();

    const q = await quoteWithCoupon(cust.token, variant.id, 'CAP200');
    expect(q.status).toBe(200);
    expect(q.body.data.discount).toBe(200);
    expect(q.body.data.total).toBe(1999 - 200 + 99);
  });

  it('a FREE_SHIPPING coupon zeroes the shipping fee', async () => {
    const admin = await adminToken();
    const { variant } = await createProduct(99900); // ₹999, below free-shipping threshold
    await adminCreateCoupon(admin, { code: 'SHIPFREE', discountType: 'FREE_SHIPPING', discountValue: 0 });
    const cust = await registerCustomer();

    const q = await quoteWithCoupon(cust.token, variant.id, 'SHIPFREE');
    expect(q.status).toBe(200);
    expect(q.body.data.discount).toBe(0);
    expect(q.body.data.shipping).toBe(0);
    expect(q.body.data.total).toBe(999);
  });

  // ---------------- Validation failures ----------------

  it('rejects unknown, disabled, scheduled and expired coupons with specific codes', async () => {
    const admin = await adminToken();
    const { variant } = await createProduct(99900);
    const cust = await registerCustomer();

    const unknown = await quoteWithCoupon(cust.token, variant.id, 'NOSUCH');
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('COUPON_INVALID');

    await adminCreateCoupon(admin, { code: 'DISABLED1', discountType: 'FIXED_AMOUNT', discountValue: 50, isActive: false });
    const disabled = await quoteWithCoupon(cust.token, variant.id, 'DISABLED1');
    expect(disabled.status).toBe(400);
    expect(disabled.body.error.code).toBe('COUPON_DISABLED');

    await adminCreateCoupon(admin, {
      code: 'SCHEDULE1', discountType: 'FIXED_AMOUNT', discountValue: 50,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const future = await quoteWithCoupon(cust.token, variant.id, 'SCHEDULE1');
    expect(future.status).toBe(400);
    expect(future.body.error.code).toBe('COUPON_NOT_STARTED');

    await adminCreateCoupon(admin, {
      code: 'EXPIRED1', discountType: 'FIXED_AMOUNT', discountValue: 50,
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const expired = await quoteWithCoupon(cust.token, variant.id, 'EXPIRED1');
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe('COUPON_EXPIRED');
  });

  it('rejects coupons below the minimum order value (evaluated on the pre-discount subtotal)', async () => {
    const admin = await adminToken();
    const { variant } = await createProduct(99900); // ₹999 < ₹1,499 minimum
    await adminCreateCoupon(admin, { code: 'MIN1499', discountType: 'PERCENTAGE', discountValue: 10, minimumOrderRupees: 1499 });
    const cust = await registerCustomer();

    const q = await quoteWithCoupon(cust.token, variant.id, 'MIN1499');
    expect(q.status).toBe(400);
    expect(q.body.error.code).toBe('COUPON_MIN_ORDER_NOT_MET');
  });

  it('rejects coupons restricted to other products', async () => {
    const admin = await adminToken();
    const { product: eligibleProduct, variant: eligibleVariant } = await createProduct(199900);
    const { variant: otherVariant } = await createProduct(199900);
    await adminCreateCoupon(admin, {
      code: 'ONLYPROD', discountType: 'PERCENTAGE', discountValue: 10, productIds: [eligibleProduct.id],
    });
    const cust = await registerCustomer();

    const ok = await quoteWithCoupon(cust.token, eligibleVariant.id, 'ONLYPROD');
    expect(ok.status).toBe(200);
    expect(ok.body.data.discount).toBe(199);

    const no = await quoteWithCoupon(cust.token, otherVariant.id, 'ONLYPROD');
    expect(no.status).toBe(400);
    expect(no.body.error.code).toBe('COUPON_NOT_APPLICABLE');
  });

  // ---------------- Order creation (COD + prepaid) ----------------

  it('applies the coupon to a COD order with authoritative backend totals', async () => {
    const admin = await adminToken();
    const { variant } = await createProduct(199900);
    await adminCreateCoupon(admin, { code: 'COD10', discountType: 'PERCENTAGE', discountValue: 10, maximumDiscountRupees: 300 });
    const cust = await registerCustomer();

    const res = await placeOrder(variant.id, 'COD', cust, 'COD10');
    expect(res.status).toBe(201);
    const order = res.body.data.order;
    expect(order.status).toBe('CONFIRMED');
    expect(order.paymentStatus).toBe('COD_PENDING');
    expect(order.couponCode).toBe('COD10');
    expect(order.subtotal).toBe(1999);
    expect(order.discount).toBe(199);
    expect(order.shipping).toBe(99);
    expect(order.total).toBe(1999 - 199 + 99);

    const row = await prisma.order.findFirstOrThrow({ where: { orderNumber: order.orderNumber } });
    const usage = await usageRow(row.id);
    expect(usage.status).toBe('ACTIVE');
    expect(usage.discountPaise).toBe(19900);
    expect(row.couponId).not.toBeNull();
  });

  it('applies the coupon to a prepaid order and keeps the usage after webhook confirmation', async () => {
    const admin = await adminToken();
    const { variant } = await createProduct(199900);
    await adminCreateCoupon(admin, { code: 'PREPAID10', discountType: 'PERCENTAGE', discountValue: 10 });
    const cust = await registerCustomer();

    const res = await placeOrder(variant.id, 'CARD', cust, 'PREPAID10');
    expect(res.status).toBe(201);
    const order = res.body.data.order;
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(order.total).toBe(1999 - 199 + 99);

    // The payment session amount equals the verified backend calculation.
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: (await prisma.order.findFirstOrThrow({ where: { orderNumber: order.orderNumber } })).id } });
    expect(payment.amountPaise).toBe(189900);

    const body = webhookBody({ providerPaymentId: 'pay_' + uniq(), providerOrderId: payment.providerOrderId, amount: payment.amountPaise });
    const ok = await postWebhook(body, sign(body));
    expect(ok.status).toBe(200);

    const usage = await usageRow(payment.orderId);
    expect(usage.status).toBe('ACTIVE');
  });

  it('releases the coupon usage when a prepaid payment fails', async () => {
    const admin = await adminToken();
    const { variant } = await createProduct(199900);
    await adminCreateCoupon(admin, { code: 'FAILREL', discountType: 'PERCENTAGE', discountValue: 10 });
    const cust = await registerCustomer();

    const res = await placeOrder(variant.id, 'CARD', cust, 'FAILREL');
    expect(res.status).toBe(201);
    const orderRow = await prisma.order.findFirstOrThrow({ where: { orderNumber: res.body.data.order.orderNumber } });
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: orderRow.id } });

    const body = webhookBody({ providerPaymentId: 'pay_' + uniq(), providerOrderId: payment.providerOrderId, amount: payment.amountPaise, status: 'failed', event: 'payment.failed' });
    const ok = await postWebhook(body, sign(body));
    expect(ok.status).toBe(200);

    const usage = await usageRow(orderRow.id);
    expect(usage.status).toBe('RELEASED');
    expect(usage.releaseReason).toBeTruthy();
  });

  it('releases the coupon usage when an admin cancels the order', async () => {
    const admin = await adminToken();
    const { variant } = await createProduct(199900);
    await adminCreateCoupon(admin, { code: 'CANCELREL', discountType: 'PERCENTAGE', discountValue: 10 });
    const cust = await registerCustomer();

    const res = await placeOrder(variant.id, 'COD', cust, 'CANCELREL');
    expect(res.status).toBe(201);
    const orderNumber = res.body.data.order.orderNumber;

    const cancel = await request(app).post('/api/v1/admin/orders/' + orderNumber + '/transition')
      .set('Authorization', 'Bearer ' + admin).send({ toStatus: 'CANCELLED' });
    expect(cancel.status).toBe(200);

    const orderRow = await prisma.order.findFirstOrThrow({ where: { orderNumber } });
    const usage = await usageRow(orderRow.id);
    expect(usage.status).toBe('RELEASED');
  });

  // ---------------- Usage limits ----------------

  it('enforces the total usage limit across customers', async () => {
    const admin = await adminToken();
    const { variant } = await createProduct(199900);
    await adminCreateCoupon(admin, { code: 'ONCEONLY', discountType: 'PERCENTAGE', discountValue: 10, totalUsageLimit: 1 });

    const first = await registerCustomer();
    const okOrder = await placeOrder(variant.id, 'COD', first, 'ONCEONLY');
    expect(okOrder.status).toBe(201);

    const second = await registerCustomer();
    const rejected = await placeOrder(variant.id, 'COD', second, 'ONCEONLY');
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('COUPON_USAGE_LIMIT_REACHED');
  });

  it('enforces the per-customer usage limit', async () => {
    const admin = await adminToken();
    const { variant } = await createProduct(199900);
    await adminCreateCoupon(admin, { code: 'ONCECUST', discountType: 'PERCENTAGE', discountValue: 10, perCustomerUsageLimit: 1 });
    const cust = await registerCustomer();

    const first = await placeOrder(variant.id, 'COD', cust, 'ONCECUST');
    expect(first.status).toBe(201);

    const second = await placeOrder(variant.id, 'COD', cust, 'ONCECUST');
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('COUPON_CUSTOMER_LIMIT_REACHED');
  });

  it('enforces the first-order-only restriction', async () => {
    const admin = await adminToken();
    const { variant } = await createProduct(199900);
    await adminCreateCoupon(admin, { code: 'FIRSTONLY', discountType: 'PERCENTAGE', discountValue: 10, firstOrderOnly: true });
    const cust = await registerCustomer();

    const first = await placeOrder(variant.id, 'COD', cust); // no coupon
    expect(first.status).toBe(201);

    const rejected = await placeOrder(variant.id, 'COD', cust, 'FIRSTONLY');
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('COUPON_FIRST_ORDER_ONLY');
  });

  it('never exceeds the total limit under concurrent redemptions (FOR UPDATE lock)', async () => {
    const admin = await adminToken();
    const { variant } = await createProduct(199900);
    await adminCreateCoupon(admin, { code: 'RACE1', discountType: 'PERCENTAGE', discountValue: 10, totalUsageLimit: 1 });

    const a = await registerCustomer();
    const b = await registerCustomer();
    const [resA, resB] = await Promise.all([
      placeOrder(variant.id, 'COD', a, 'RACE1'),
      placeOrder(variant.id, 'COD', b, 'RACE1'),
    ]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 400]);
    const activeUsages = await prisma.couponUsage.count({
      where: { coupon: { code: 'RACE1' }, status: 'ACTIVE' },
    });
    expect(activeUsages).toBe(1);
  });

  // ---------------- Admin CRUD + authorization ----------------

  it('requires admin authorization for coupon management and rejects duplicate codes', async () => {
    const anon = await request(app).post('/api/v1/admin/coupons').send({
      code: 'ANONX', internalName: 'x', discountType: 'PERCENTAGE', discountValue: 10,
    });
    expect(anon.status).toBe(401);

    const cust = await registerCustomer();
    const asCustomer = await request(app).post('/api/v1/admin/coupons')
      .set('Authorization', 'Bearer ' + cust.token)
      .send({ code: 'NOTADMIN', internalName: 'x', discountType: 'PERCENTAGE', discountValue: 10 });
    expect(asCustomer.status).toBe(403);

    const admin = await adminToken();
    const created1 = await adminCreateCoupon(admin, { code: 'dup_code', discountType: 'PERCENTAGE', discountValue: 10 });
    expect(created1.status).toBe(201);
    expect(created1.body.data.code).toBe('DUP_CODE'); // normalised uppercase

    const created2 = await adminCreateCoupon(admin, { code: 'DUP_CODE', discountType: 'PERCENTAGE', discountValue: 10 });
    expect(created2.status).toBe(400);

    // Listing, toggle and usage endpoints work and audit-log mutations.
    const list = await request(app).get('/api/v1/admin/coupons?search=DUP_CODE').set('Authorization', 'Bearer ' + admin);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.data[0].status).toBe('ACTIVE');
    expect(list.body.data[0].usageCount).toBe(0);

    const id = created1.body.data.id;
    const toggle = await request(app).post('/api/v1/admin/coupons/' + id + '/toggle').set('Authorization', 'Bearer ' + admin).send({});
    expect(toggle.status).toBe(200);
    expect(toggle.body.data.isActive).toBe(false);

    const usage = await request(app).get('/api/v1/admin/coupons/' + id + '/usage').set('Authorization', 'Bearer ' + admin);
    expect(usage.status).toBe(200);
    expect(usage.body.summary.activeUsages).toBe(0);

    const auditLog = await prisma.auditLog.findFirst({ where: { action: 'COUPON_CREATED', entityId: id } });
    expect(auditLog).not.toBeNull();
  });

  // ---------------- Public listing ----------------

  it('lists only safe public coupons and excludes private, exhausted and other-product coupons', async () => {
    const admin = await adminToken();
    const { product, variant } = await createProduct(199900);
    const { product: product2 } = await createProduct(199900);

    await adminCreateCoupon(admin, {
      code: 'PUB10', discountType: 'PERCENTAGE', discountValue: 10, isPublic: true,
      productIds: [product.id],
    });
    await adminCreateCoupon(admin, { code: 'PRIV10', discountType: 'PERCENTAGE', discountValue: 10, isPublic: false });
    await adminCreateCoupon(admin, { code: 'EXHAUST10', discountType: 'PERCENTAGE', discountValue: 10, isPublic: true, totalUsageLimit: 1 });
    await adminCreateCoupon(admin, { code: 'OTHERPROD', discountType: 'PERCENTAGE', discountValue: 10, isPublic: true, productIds: [product2.id] });

    // Exhaust the EXHAUST10 coupon with one COD order.
    const cust = await registerCustomer();
    const used = await placeOrder(variant.id, 'COD', cust, 'EXHAUST10');
    expect(used.status).toBe(201);

    const list = await request(app).get('/api/v1/coupons');
    expect(list.status).toBe(200);
    const codes = list.body.data.map((c: { code: string }) => c.code);
    expect(codes).toContain('PUB10');
    expect(codes).not.toContain('PRIV10');     // private
    expect(codes).not.toContain('EXHAUST10');  // exhausted
    // A public coupon restricted to another product still appears in the
    // unfiltered listing (it is applicable to some product), but is excluded
    // from that product's page (asserted below).
    // Safe fields only: no internal name or usage counters.
    const pub = list.body.data.find((c: { code: string }) => c.code === 'PUB10');
    expect(pub).toBeDefined();
    expect(pub.internalName).toBeUndefined();
    expect(pub.totalUsageLimit).toBeUndefined();
    expect(pub.discountDisplay).toBe('10% off');

    // Product-filtered listing keeps only coupons applicable to that product.
    const forProduct = await request(app).get('/api/v1/coupons?productSlug=' + product.slug);
    expect(forProduct.status).toBe(200);
    const filteredCodes = forProduct.body.data.map((c: { code: string }) => c.code);
    expect(filteredCodes).toContain('PUB10');
    expect(filteredCodes).not.toContain('OTHERPROD');
    expect(filteredCodes).not.toContain('PRIV10');
  });
});
