import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const run = process.env.TEST_DATABASE_URL ? describe : describe.skip;

run('catalog + cart + auth API (integration)', () => {
  const prisma = new PrismaClient();

  let app: import('express').Express;
  let adminToken = '';
  let sportProductId = '';
  let lifestyleProductId = '';

  const stamp = Date.now();

  const sportSlug = 'ci-catalog-sport-' + stamp;
  const lifestyleSlug = 'ci-catalog-lifestyle-' + stamp;
  const adminEmail = 'ci-catalog-admin-' + stamp + '@example.com';

  const createProductPayload = (
    slug: string,
    name: string,
    categorySlug: string,
    sku: string,
  ) => ({
    slug,
    name,
    shortDescription: 'Temporary catalogue integration test product.',
    description: 'A temporary product used to test catalogue API behaviour.',
    categorySlug,
    collectionSlug: 'athlete-series',
    status: 'ACTIVE',
    price: 1799,
    isFeatured: false,
    isNewArrival: true,
    isBestSeller: false,
    materials: ['600D Polyester'],
    tags: ['catalog-test', 'backpack'],
    images: [
      {
        url: 'https://example.com/catalog-test-product.jpg',
        alt: name,
      },
    ],
    features: [
      {
        title: 'Test Feature',
        description: 'A feature used for catalogue integration testing.',
        icon: 'package',
      },
    ],
    variants: [
      {
        sku,
        colorName: 'Black',
        colorHex: '#000000',
        inventoryQty: 5,
      },
    ],
  });

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';

    const { createApp } = await import('../../src/app');
    app = createApp();

    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await bcrypt.hash('Password1234', 4),
        firstName: 'CI',
        lastName: 'Catalog Admin',
        emailVerifiedAt: new Date(),
        roles: {
          create: {
            role: {
              connect: { name: 'ADMIN' },
            },
          },
        },
      },
    });

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: adminEmail,
        password: 'Password1234',
      });

    expect(login.status).toBe(200);
    adminToken = login.body.data.accessToken as string;

    const sportProduct = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', 'Bearer ' + adminToken)
      .send(
        createProductPayload(
          sportSlug,
          'CI Sport Backpack',
          'bags',
          'KIEN-CAT-SP-' + stamp,
        ),
      );

    expect(sportProduct.status).toBe(201);
    sportProductId = sportProduct.body.data.id;

    const lifestyleProduct = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', 'Bearer ' + adminToken)
      .send(
        createProductPayload(
          lifestyleSlug,
          'CI Lifestyle Bag',
          'sling-bags',
          'KIEN-CAT-LS-' + stamp,
        ),
      );

    expect(lifestyleProduct.status).toBe(201);
    lifestyleProductId = lifestyleProduct.body.data.id;
  });

  afterAll(async () => {
    if (sportProductId) {
      await prisma.product.delete({
        where: { id: sportProductId },
      }).catch(() => undefined);
    }

    if (lifestyleProductId) {
      await prisma.product.delete({
        where: { id: lifestyleProductId },
      }).catch(() => undefined);
    }

    await prisma.user.deleteMany({
      where: { email: adminEmail },
    }).catch(() => undefined);

    await prisma.$disconnect();
  });

  it('health endpoint responds', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
  });

  it('lists products created by this test', async () => {
    const res = await request(app).get('/api/v1/products');

    expect(res.status).toBe(200);

    const slugs = res.body.data.data.map(
      (p: { slug: string }) => p.slug,
    );

    expect(slugs).toContain(sportSlug);
    expect(slugs).toContain(lifestyleSlug);
  });

  it('returns frontend-shaped product data', async () => {
    const res = await request(app).get(
      '/api/v1/products/' + sportSlug,
    );

    expect(res.status).toBe(200);

    const product = res.body.data;

    expect(product.slug).toBe(sportSlug);
    expect(product.price).toBe(1799);
    expect(product.category).toBe('sport');
    expect(product.colors.length).toBe(1);
    expect(product.images.length).toBe(1);
    expect(product.features.length).toBe(1);
    expect(typeof product.inStock).toBe('boolean');
    expect(product.variants.length).toBe(1);
  });

  it('filters products by world', async () => {
    const sport = await request(app)
      .get('/api/v1/products?category=sport');

    const lifestyle = await request(app)
      .get('/api/v1/products?category=lifestyle');

    expect(sport.status).toBe(200);
    expect(lifestyle.status).toBe(200);

    const sportSlugs = sport.body.data.data.map(
      (p: { slug: string }) => p.slug,
    );

    const lifestyleSlugs = lifestyle.body.data.data.map(
      (p: { slug: string }) => p.slug,
    );

    expect(sportSlugs).toContain(sportSlug);
    expect(sportSlugs).not.toContain(lifestyleSlug);

    expect(lifestyleSlugs).toContain(lifestyleSlug);
    expect(lifestyleSlugs).not.toContain(sportSlug);
  });

  it('searches by keyword', async () => {
    const res = await request(app)
      .get('/api/v1/search?q=CI+Sport+Backpack');

    expect(res.status).toBe(200);

    expect(
      res.body.data.some(
        (p: { slug: string }) => p.slug === sportSlug,
      ),
    ).toBe(true);
  });

  it('rejects invalid cart additions with a validation error', async () => {
    const res = await request(app)
      .post('/api/v1/cart/items')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('registers a customer and returns an access token and refresh cookie', async () => {
    const email = 'it-' + Date.now() + '@example.com';

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email,
        password: 'Password123',
        firstName: 'Test',
        lastName: 'User',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toBeTruthy();

    expect(
      (res.headers['set-cookie'] as unknown as string[]).some(
        (cookie: string) => cookie.startsWith('kien_refresh'),
      ),
    ).toBe(true);
  });

  it('does not allow duplicate registration', async () => {
    const email = 'dup-' + Date.now() + '@example.com';

    await request(app)
      .post('/api/v1/auth/register')
      .send({
        email,
        password: 'Password123',
        firstName: 'Test',
        lastName: 'User',
      });

    const duplicate = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email,
        password: 'Password123',
        firstName: 'Test',
        lastName: 'User',
      });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('refuses unauthenticated access to account endpoints', async () => {
    const res = await request(app).get('/api/v1/account');

    expect(res.status).toBe(401);
  });

  it('refuses non-admin access to admin endpoints', async () => {
    const email = 'cust-' + Date.now() + '@example.com';

    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email,
        password: 'Password123',
        firstName: 'Test',
        lastName: 'User',
      });

    const token = reg.body.data.accessToken as string;

    const res = await request(app)
      .get('/api/v1/admin/products')
      .set('Authorization', 'Bearer ' + token);

    expect(res.status).toBe(403);
  });
});
