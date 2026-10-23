import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';

// Integration tests for the admin Inventory endpoints.
// Regression coverage for the blank-screen bug: the movements response must
// include the nested `variant` object the frontend renders, alongside the
// flat fields. Also covers the summary metrics endpoint, stock adjustments
// (transactional, movement-recorded, never negative) and authorization.

const run = process.env.DATABASE_URL ? describe : describe.skip;

run('Admin inventory endpoints (integration)', () => {
  let app: Express;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
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

  const createProduct = async (pricePaise: number, availableQty = 10) => {
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
    await prisma.inventory.create({ data: { variantId: variant.id, availableQty, reservedQty: 0, soldQty: 0 } });
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

  it('requires admin authorization', async () => {
    const anon = await request(app).get('/api/v1/admin/inventory/movements');
    expect(anon.status).toBe(401);
    const cust = await registerCustomer();
    const asCustomer = await request(app).get('/api/v1/admin/inventory/movements').set('Authorization', 'Bearer ' + cust.token);
    expect(asCustomer.status).toBe(403);
  });

  it('returns movements with BOTH flat fields and the nested variant object (blank-screen regression)', async () => {
    const admin = await adminToken();
    const { product, variant } = await createProduct(199900);

    // Generate a movement: place a COD order (inventory reservation).
    const cust = await registerCustomer();
    const agent = request.agent(app);
    await agent.post('/api/v1/cart/items').set('Authorization', 'Bearer ' + cust.token).send({ variantId: variant.id, quantity: 1 });
    const order = await agent.post('/api/v1/orders').set('Authorization', 'Bearer ' + cust.token).send({
      email: cust.email,
      address: { firstName: 'Cust', lastName: 'Test', line1: '1 Test St', city: 'Bengaluru', state: 'Karnataka', pincode: '560001', phone: '9876543210' },
      paymentMethod: 'COD',
    });
    expect(order.status).toBe(201);
    const row = await prisma.order.findFirstOrThrow({ where: { orderNumber: order.body.data.order.orderNumber } });
    created.orderIds.push(row.id);

    const res = await request(app)
      .get('/api/v1/admin/inventory/movements')
      .query({ sku: variant.sku })
      .set('Authorization', 'Bearer ' + admin);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);

    const movement = res.body.data.find((m: { sku: string | null }) => m.sku === variant.sku);
    expect(movement).toBeDefined();
    // Flat contract (backwards compatible)...
    expect(movement.sku).toBe(variant.sku);
    expect(movement.product).toBe(product.name);
    // ...AND the nested object the Inventory page actually renders.
    expect(movement.variant).toBeDefined();
    expect(movement.variant.sku).toBe(variant.sku);
    expect(movement.variant.product.name).toBe(product.name);
    expect(movement.deltaQty).toBe(-1);
    expect(movement.type).toBe('RESERVE');
  });

  it('returns summary metrics without inventing an inventory value', async () => {
    const admin = await adminToken();
    await createProduct(199900, 3); // 3 units: below the default low-stock threshold of 5
    await createProduct(199900, 0); // out of stock

    const res = await request(app).get('/api/v1/admin/inventory/summary').set('Authorization', 'Bearer ' + admin);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.totalItems).toBeGreaterThanOrEqual(2);
    expect(data.totalUnitsInStock).toBeGreaterThanOrEqual(3);
    expect(data.lowStockItems).toBeGreaterThanOrEqual(1);
    expect(data.outOfStockItems).toBeGreaterThanOrEqual(1);
    // No cost-price data exists: valuation must be explicitly absent.
    expect(data.inventoryValue).toBeNull();
  });

  it('applies stock adjustments transactionally, records the movement, and refuses negative stock', async () => {
    const admin = await adminToken();
    const { variant } = await createProduct(199900, 10);
    const auth = 'Bearer ' + admin;

    // Add stock with a mandatory-style reason.
    const add = await request(app).post('/api/v1/admin/inventory/adjust').set('Authorization', auth).send({
      sku: variant.sku, deltaQty: 5, type: 'RESTOCK', reason: 'Received shipment PO-123',
    });
    expect(add.status).toBe(200);
    expect(add.body.data.availableQty).toBe(15);

    // Correct stock downward.
    const remove = await request(app).post('/api/v1/admin/inventory/adjust').set('Authorization', auth).send({
      sku: variant.sku, deltaQty: -3, type: 'ADJUST', reason: 'Cycle count correction',
    });
    expect(remove.status).toBe(200);
    expect(remove.body.data.availableQty).toBe(12);

    // Movements are recorded with the admin actor.
    const movements = await request(app)
      .get('/api/v1/admin/inventory/movements')
      .query({ sku: variant.sku })
      .set('Authorization', auth);
    expect(movements.status).toBe(200);
    const adjustmentMoves = movements.body.data.filter((m: { type: string }) => ['RESTOCK', 'ADJUST'].includes(m.type));
    expect(adjustmentMoves.length).toBe(2);
    expect(adjustmentMoves[0].actorId).not.toBeNull();
    expect(adjustmentMoves[0].reference).toBe('Cycle count correction');

    // Stock can never become negative.
    const negative = await request(app).post('/api/v1/admin/inventory/adjust').set('Authorization', auth).send({
      sku: variant.sku, deltaQty: -100, type: 'ADJUST', reason: 'Erroneous huge deduction',
    });
    expect(negative.status).toBe(400);
    const inv = await prisma.inventory.findFirstOrThrow({ where: { variantId: variant.id } });
    expect(inv.availableQty).toBe(12);

    // The adjustment is audit-logged.
    const log = await prisma.auditLog.findFirst({ where: { action: 'INVENTORY_ADJUSTED', entityId: variant.id } });
    expect(log).not.toBeNull();
  });
});
