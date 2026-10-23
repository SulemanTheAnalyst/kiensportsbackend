import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';

// Integration tests for the admin Settings configuration centre and the
// inventory admin endpoints. Requires a migrated Postgres; skips without
// DATABASE_URL. No secrets are ever asserted by value.

const run = process.env.DATABASE_URL ? describe : describe.skip;

run('Settings + inventory admin (integration)', () => {
  let app: Express;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  const created: { productIds: string[]; categoryIds: string[]; userIds: string[]; orderIds: string[] } = {
    productIds: [], categoryIds: [], userIds: [], orderIds: [],
  };
  const original: Record<string, unknown>[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    const mod = await import('../../src/app');
    app = mod.createApp();
    const prismaMod = await import('../../src/lib/prisma');
    prisma = prismaMod.prisma;
  });

  afterAll(async () => {
    // Restore the settings rows this suite touched so other suites and the
    // running environment are not polluted.
    for (const row of original) {
      await prisma.businessSetting.update({
        where: { key: row.section as string },
        data: { value: row.value as object },
      }).catch(() => undefined);
    }
    for (const id of created.orderIds) await prisma.order.delete({ where: { id } }).catch(() => undefined);
    for (const id of created.productIds) await prisma.product.delete({ where: { id } }).catch(() => undefined);
    for (const id of created.categoryIds) await prisma.category.delete({ where: { id } }).catch(() => undefined);
    for (const id of created.userIds) await prisma.user.delete({ where: { id } }).catch(() => undefined);
  });

  const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

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

  const customerToken = async () => {
    const stamp = uniq();
    const email = 'cust-' + stamp + '@example.com';
    const reg = await request(app).post('/api/v1/auth/register').send({
      email, password: 'Password123', firstName: 'Cust', lastName: 'Test',
    });
    expect(reg.status).toBe(201);
    const user = await prisma.user.findUnique({ where: { email } });
    created.userIds.push(user.id);
    return reg.body.data.accessToken as string;
  };

  // Snapshot + restore helper for the settings a test mutates.
  const snapshotSection = async (section: string) => {
    const row = await prisma.businessSetting.findUnique({ where: { key: section } });
    if (row) original.push({ section: row.key, value: row.value });
  };

  // ---------------- Authorization ----------------

  it('rejects unauthenticated and non-admin access to settings and coupons', async () => {
    const anon = await request(app).get('/api/v1/admin/settings');
    expect(anon.status).toBe(401);
    const cust = await request(app).get('/api/v1/admin/settings').set('Authorization', 'Bearer ' + (await customerToken()));
    expect(cust.status).toBe(403);
    const health = await request(app).get('/api/v1/admin/settings/system-health');
    expect(health.status).toBe(401);
  });

  // ---------------- Read + update ----------------

  it('lets admins read all settings sections and update them with validation', async () => {
    const token = await adminToken();
    const read = await request(app).get('/api/v1/admin/settings').set('Authorization', 'Bearer ' + token);
    expect(read.status).toBe(200);
    for (const section of ['general', 'orders', 'inventory', 'checkout', 'shippingReturns', 'notifications']) {
      expect(read.body.data[section]).toBeDefined();
    }
    expect(read.body.data.general.currency).toBe('INR');
    expect(read.body.data.general.timezone).toBe('Asia/Kolkata');
    // Defaults preserve the existing launch shipping rule.
    expect(read.body.data.checkout.flatShippingRupees).toBe(99);
    expect(read.body.data.checkout.freeShippingThresholdRupees).toBe(2000);

    await snapshotSection('general');
    const patch = await request(app).patch('/api/v1/admin/settings').set('Authorization', 'Bearer ' + token).send({
      general: { brandName: 'KIEN Sports', supportEmail: 'support-test@example.com' },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.data.general.supportEmail).toBe('support-test@example.com');
    expect(patch.body.data.general.brandName).toBe('KIEN Sports');

    // Invalid values are rejected.
    const bad = await request(app).patch('/api/v1/admin/settings').set('Authorization', 'Bearer ' + token).send({
      general: { supportEmail: 'not-an-email' },
    });
    expect(bad.status).toBe(400);

    const badSection = await request(app).patch('/api/v1/admin/settings').set('Authorization', 'Bearer ' + token).send({
      secretKey: 'value',
    });
    expect(badSection.status).toBe(400); // strict schema: unknown section rejected
  });

  it('reports integration health as flags only, never secret values', async () => {
    const token = await adminToken();
    const health = await request(app).get('/api/v1/admin/settings/system-health').set('Authorization', 'Bearer ' + token);
    expect(health.status).toBe(200);
    const d = health.body.data;
    expect(d.database).toBeDefined();
    expect(d.email.sendingConfigured).toBeDefined();
    expect(d.payments.status).toBeDefined();
    expect(d.productMediaStorage.status).toBeDefined();
    // Backup status must not claim success without evidence.
    expect(d.backups.status).toBe('UNKNOWN');
    // The payload must not contain credential-looking values anywhere.
    const raw = JSON.stringify(d);
    expect(raw).not.toMatch(/postgres:\/\//i);
    expect(raw).not.toMatch(/sk_[A-Za-z0-9]/);
    expect(raw).not.toMatch(/rzp_/i);
  });

  it('exposes notification history from the outbox', async () => {
    const token = await adminToken();
    const history = await request(app).get('/api/v1/admin/settings/notification-history').set('Authorization', 'Bearer ' + token);
    expect(history.status).toBe(200);
    // The endpoint returns the rows array directly in `data` (envelope style),
    // plus pagination + last send/error summary.
    expect(Array.isArray(history.body.data)).toBe(true);
    expect(history.body.summary).toBeDefined();
  });

  it('validates the test-email recipient and rejects anonymous callers', async () => {
    const anon = await request(app).post('/api/v1/admin/settings/test-email').send({ to: 'a@example.com' });
    expect(anon.status).toBe(401);
    const token = await adminToken();
    const bad = await request(app).post('/api/v1/admin/settings/test-email').set('Authorization', 'Bearer ' + token).send({ to: 'not-an-email' });
    expect(bad.status).toBe(400);
    // The endpoint always answers 200 with an accepted flag: with no Resend
    // key in the test environment accepted=false, but it must never crash or
    // leak secrets.
    const ok = await request(app).post('/api/v1/admin/settings/test-email').set('Authorization', 'Bearer ' + token).send({ to: 'ops-test@example.com' });
    expect(ok.status).toBe(200);
    expect(typeof ok.body.data.accepted).toBe('boolean');
  });

  // ---------------- Inventory admin endpoints ----------------

  const createVariant = async () => {
    const stamp = uniq();
    const category = await prisma.category.create({
      data: { slug: 'cat-' + stamp, name: 'Cat ' + stamp, world: 'sport', description: 't' },
    });
    created.categoryIds.push(category.id);
    const product = await prisma.product.create({
      data: {
        slug: 'prod-' + stamp, name: 'Prod ' + stamp, shortDescription: 's', description: 'd',
        categoryId: category.id, pricePaise: 199900, status: 'ACTIVE',
        variants: { create: { sku: 'SKU-' + stamp, colorName: 'Black', colorHex: '#000000', size: 'M' } },
      },
    });
    created.productIds.push(product.id);
    const variant = await prisma.productVariant.findFirstOrThrow({ where: { productId: product.id } });
    await prisma.inventory.create({ data: { variantId: variant.id, availableQty: 5, reservedQty: 0, soldQty: 0, lowStockThreshold: 2 } });
    return variant;
  };

  it('returns the inventory list, summary and the NESTED movement shape the page renders', async () => {
    const token = await adminToken();
    const variant = await createVariant();

    const list = await request(app).get('/api/v1/admin/inventory?page=1&limit=25').set('Authorization', 'Bearer ' + token);
    expect(list.status).toBe(200);
    const item = list.body.data.find((v: { sku: string }) => v.sku === variant.sku);
    expect(item).toBeDefined();
    expect(item.inventory.availableQty).toBe(5);
    expect(item.inventory.lowStockThreshold).toBe(2);

    const summary = await request(app).get('/api/v1/admin/inventory/summary').set('Authorization', 'Bearer ' + token);
    expect(summary.status).toBe(200);
    for (const key of ['totalItems', 'unitsInStock', 'unitsReserved', 'lowStockItems', 'outOfStockItems']) {
      expect(typeof summary.body.data[key]).toBe('number');
    }

    // The variant was created directly in the database, so seed one movement
    // through the real adjust endpoint before asserting the history shape.
    const seed = await request(app).post('/api/v1/admin/inventory/adjust').set('Authorization', 'Bearer ' + token).send({
      sku: variant.sku, deltaQty: 1, type: 'RESTOCK', reason: 'Seed movement for the shape test',
    });
    expect(seed.status).toBe(200);
    // The movements response must include the nested variant shape that the
    // Inventory page dereferences (the original blank-screen bug was this
    // exact contract returning only flattened fields).
    const movements = await request(app).get('/api/v1/admin/inventory/movements?sku=' + variant.sku).set('Authorization', 'Bearer ' + token);
    expect(movements.status).toBe(200);
    expect(movements.body.data.length).toBeGreaterThanOrEqual(1);
    const m = movements.body.data[0];
    expect(m.variant).toBeDefined();
    expect(typeof m.variant.sku).toBe('string');
    expect(m.variant.product).toBeDefined();
    expect(typeof m.variant.product.name).toBe('string');
    expect(m.variant.sku).toBe(variant.sku);
  });

  it('adjusts stock transactionally, records the movement and refuses negative stock', async () => {
    const token = await adminToken();
    const variant = await createVariant();

    const add = await request(app).post('/api/v1/admin/inventory/adjust').set('Authorization', 'Bearer ' + token).send({
      sku: variant.sku, deltaQty: 3, type: 'RESTOCK', reason: 'Test restock',
    });
    expect(add.status).toBe(200);
    expect(add.body.data.availableQty).toBe(8);

    const negative = await request(app).post('/api/v1/admin/inventory/adjust').set('Authorization', 'Bearer ' + token).send({
      sku: variant.sku, deltaQty: -100, type: 'ADJUST', reason: 'Should fail',
    });
    expect(negative.status).toBe(400);

    const correct = await request(app).post('/api/v1/admin/inventory/adjust').set('Authorization', 'Bearer ' + token).send({
      sku: variant.sku, deltaQty: -2, type: 'ADJUST', reason: 'Cycle count correction',
    });
    expect(correct.status).toBe(200);
    expect(correct.body.data.availableQty).toBe(6);

    const movements = await request(app).get('/api/v1/admin/inventory/movements?sku=' + variant.sku).set('Authorization', 'Bearer ' + token);
    const reasons = movements.body.data.map((m: { reference: string | null }) => m.reference);
    expect(reasons).toContain('Test restock');
    expect(reasons).toContain('Cycle count correction');
    // The admin's email is resolved for auditability.
    const withActor = movements.body.data.filter((m: { actorEmail: string | null }) => m.actorEmail !== null);
    expect(withActor.length).toBeGreaterThan(0);
    expect(withActor[0].actorEmail).toMatch(/@example\.com$/);
  });
});
