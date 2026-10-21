import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

// Integration test: requires a running Postgres (docker compose up -d db)
// and a migrated+seeded database (npm run db:migrate && npm run db:seed).
// Skips automatically when DATABASE_URL is not configured.
//
// Covers the full admin product-creation workflow end to end:
// - GET /categories and /collections (reference data for the admin form)
// - POST /admin/products authorization (401 anonymous, 403 customer)
// - POST /admin/products validation (unknown categorySlug, invalid price,
//   duplicate slug)
// - POST /admin/products happy path + persistence via the admin catalog
//   list and the compact admin product list
// - seeded catalog data remains intact

const run = process.env.DATABASE_URL ? describe : describe.skip;

run('admin product creation workflow (integration)', () => {
  const prisma = new PrismaClient();
  let app: import('express').Express;
  let adminToken = '';
  const stamp = Date.now();
  const slug = 'ci-test-product-' + stamp;
  const sku = 'KIEN-TST-' + stamp;
  let createdId: string | undefined;

  const baseProduct = {
    slug,
    name: 'CI Test Product',
    shortDescription: 'Created by the product-creation integration test.',
    description: 'A product created by the automated integration test to verify the full admin creation workflow.',
    categorySlug: 'bags',
    collectionSlug: 'athlete-series',
    status: 'ACTIVE',
    price: 1999,
    compareAtPrice: 2499,
    isFeatured: false,
    isNewArrival: true,
    isBestSeller: false,
    dimensions: '40cm x 25cm x 15cm',
    weightGrams: 800,
    capacity: '18 Liters',
    materials: ['600D Ripstop Nylon'],
    tags: ['test'],
    seoTitle: 'CI Test Product',
    seoDescription: 'Integration test product.',
    images: [{ url: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=800&h=1000&fit=crop&q=80', alt: 'CI Test Product' }],
    features: [{ title: 'Test Feature', description: 'Integration test feature.', icon: 'package' }],
    variants: [
      { sku, colorName: 'Matte Black', colorHex: '#1a1a1a', inventoryQty: 5 },
    ],
  };

  beforeAll(async () => {
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    const { createApp } = await import('../../src/app');
    app = createApp();

    // Dedicated admin user (direct Prisma, ADMIN role) -> login for a token.
    const email = 'ci-admin-' + stamp + '@example.com';
    await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash('Password1234', 4),
        firstName: 'CI',
        lastName: 'Admin',
        emailVerifiedAt: new Date(),
        roles: { create: { role: { connect: { name: 'ADMIN' } } } },
      },
    });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'Password1234' });
    expect(login.status).toBe(200);
    adminToken = login.body.data.accessToken as string;
  });

  afterAll(async () => {
    if (createdId) {
      await prisma.product.delete({ where: { id: createdId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  it('exposes seeded categories for the admin form dropdown', async () => {
    const res = await request(app).get('/api/v1/categories');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect((res.body.data as unknown[]).length).toBeGreaterThanOrEqual(12);
    for (const c of res.body.data as { slug: string; name: string; world: string }[]) {
      expect(c.slug).toBeTruthy();
      expect(c.name).toBeTruthy();
      expect(c.world).toBeTruthy();
    }
  });

  it('exposes seeded collections for the admin form dropdown', async () => {
    const res = await request(app).get('/api/v1/collections');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect((res.body.data as unknown[]).length).toBeGreaterThanOrEqual(3);
  });

  it('requires authentication (401 without a token)', async () => {
    const res = await request(app).post('/api/v1/admin/products').send(baseProduct);
    expect(res.status).toBe(401);
  });

  it('requires the ADMIN role (403 for a CUSTOMER token)', async () => {
    const email = 'ci-cust-' + stamp + '@example.com';
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Password123', firstName: 'Test', lastName: 'User' });
    expect(reg.status).toBe(201);
    const res = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', 'Bearer ' + reg.body.data.accessToken)
      .send(baseProduct);
    expect(res.status).toBe(403);
  });

  it('rejects an unknown categorySlug with 400', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ ...baseProduct, categorySlug: 'does-not-exist-' + stamp });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('rejects invalid prices (zero, negative, non-integer) with 400', async () => {
    for (const price of [0, -5, 1999.5]) {
      const res = await request(app)
        .post('/api/v1/admin/products')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ ...baseProduct, price });
      expect(res.status).toBe(400);
    }
  });

  it('rejects a duplicate slug with 400', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ ...baseProduct, slug: 'kien-athlete-40l' });
    expect(res.status).toBe(400);
  });

  it('creates a product (201) and persists it with the expected data', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', 'Bearer ' + adminToken)
      .send(baseProduct);
    expect(res.status).toBe(201);
    expect(res.body.data.slug).toBe(slug);
    createdId = res.body.data.id as string;

    // Full record via the admin catalog list (used by the admin edit form).
    const list = await request(app)
      .get('/api/v1/admin/catalog/products')
      .query({ search: slug })
      .set('Authorization', 'Bearer ' + adminToken);
    expect(list.status).toBe(200);
    const item = (list.body.data as Record<string, unknown>[]).find((p) => p.slug === slug);
    expect(item).toBeTruthy();
    expect(item!.price).toBe(1999);
    expect(item!.compareAtPrice).toBe(2499);
    expect(item!.status).toBe('ACTIVE');
    expect(item!.categorySlug).toBe('bags');
    expect(item!.collectionSlug).toBe('athlete-series');
    expect((item!.variants as { sku: string; inventory: { availableQty: number } }[])[0].sku).toBe(sku);
    expect((item!.variants as { inventory: { availableQty: number } }[])[0].inventory.availableQty).toBe(5);

    // Compact admin product list (Products table in the admin panel).
    const compact = await request(app)
      .get('/api/v1/admin/products')
      .query({ limit: 60 })
      .set('Authorization', 'Bearer ' + adminToken);
    expect(compact.status).toBe(200);
    const row = (compact.body.data as Record<string, unknown>[]).find((p) => p.slug === slug);
    expect(row).toBeTruthy();
    expect(row!.price).toBe(1999);
  });

  it('leaves existing seeded products intact', async () => {
    const res = await request(app)
      .get('/api/v1/admin/products')
      .query({ limit: 60 })
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(200);
    const slugs = (res.body.data as Record<string, unknown>[]).map((p) => p.slug);
    expect(slugs).toContain('kien-athlete-40l');
    expect(slugs).toContain('kien-duffel');
    expect(slugs).toContain('kien-lifestyle-sling');
  });
});
