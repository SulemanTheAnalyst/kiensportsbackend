import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

// Integration test: requires a running Postgres (docker compose up -d db)
// and a migrated+seeded database (npm run db:migrate && npm run db:seed).
// Skips automatically when DATABASE_URL is not configured.
//
// Covers the admin product-management workflow end to end:
// - GET /admin/catalog/products/:id and :slug (full record for the edit form)
// - PATCH /admin/products/:id scalars + audit logging
// - PATCH /admin/products/:id images (replace / reorder / add) incl. 400 on
//   an image id that belongs to a different product
// - POST /admin/products/:id/archive (idempotent)
// - DELETE /admin/products/:id (cascades verified, audit logged)
// - DELETE refused with 409 when the product has order history
// - POST /admin/images: 401/403, 400 empty / bad type / oversized,
//   503 when storage is unconfigured, 201 with an injected fake storage
//
// No real Cloudinary credentials are used: the storage module exposes a
// test seam (__setStorageForTests) and CI injects a fake implementation.

const run = process.env.DATABASE_URL ? describe : describe.skip;

run('admin product management workflow (integration)', () => {
  const prisma = new PrismaClient();
  let app: import('express').Express;
  let adminToken = '';
  const stamp = Date.now();
  const slug = 'ci-mgmt-product-' + stamp;
  const sku = 'KIEN-MGMT-' + stamp;
  let productId: string | undefined;
  const createdProductIds: string[] = [];

  const baseProduct = {
    slug,
    name: 'CI Mgmt Product',
    shortDescription: 'Created by the product-management integration test.',
    description: 'A product created by the automated integration test to verify edit, archive and delete behaviour.',
    categorySlug: 'bags',
    collectionSlug: 'athlete-series',
    status: 'ACTIVE',
    price: 1499,
    isFeatured: false,
    isNewArrival: false,
    isBestSeller: false,
    materials: ['600D Ripstop Nylon'],
    tags: ['test'],
    images: [
      { url: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=800&h=1000&fit=crop&q=80', alt: 'CI Mgmt Product 1' },
      { url: 'https://images.unsplash.com/photo-1547949003-9792a18a2601?w=800&h=1000&fit=crop&q=80', alt: 'CI Mgmt Product 2' },
    ],
    features: [{ title: 'Mgmt Feature', description: 'Integration test feature.', icon: 'package' }],
    variants: [{ sku, colorName: 'Matte Black', colorHex: '#1a1a1a', inventoryQty: 7 }],
  };

  beforeAll(async () => {
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    const { createApp } = await import('../../src/app');
    app = createApp();

    const email = 'ci-mgmt-admin-' + stamp + '@example.com';
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
    // Best-effort cleanup of everything this test created.
    await prisma.order.deleteMany({ where: { orderNumber: { startsWith: 'CI-MGMT-' + stamp } } }).catch(() => undefined);
    for (const id of createdProductIds) {
      await prisma.product.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  it('creates a product to manage (201)', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', 'Bearer ' + adminToken)
      .send(baseProduct);
    expect(res.status).toBe(201);
    productId = res.body.data.id as string;
    createdProductIds.push(productId!);
  });

  it('returns the full product record by id (edit-form source)', async () => {
    const res = await request(app)
      .get('/api/v1/admin/catalog/products/' + productId)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(productId);
    expect(res.body.data.slug).toBe(slug);
    expect(res.body.data.images.length).toBe(2);
    expect(res.body.data.images[0].alt).toBe('CI Mgmt Product 1');
  });

  it('returns the full product record by slug (list links use slug)', async () => {
    const res = await request(app)
      .get('/api/v1/admin/catalog/products/' + slug)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(productId);
  });

  it('404s for an unknown product id', async () => {
    const res = await request(app)
      .get('/api/v1/admin/catalog/products/no-such-product-' + stamp)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(404);
  });

  it('requires authentication (401) and the ADMIN role (403)', async () => {
    const anon = await request(app).get('/api/v1/admin/catalog/products/' + slug);
    expect(anon.status).toBe(401);
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'ci-mgmt-cust-' + stamp + '@example.com', password: 'Password123', firstName: 'T', lastName: 'U' });
    expect(reg.status).toBe(201);
    const customer = await request(app)
      .get('/api/v1/admin/catalog/products/' + slug)
      .set('Authorization', 'Bearer ' + reg.body.data.accessToken);
    expect(customer.status).toBe(403);
    const customerDel = await request(app)
      .delete('/api/v1/admin/products/' + productId)
      .set('Authorization', 'Bearer ' + reg.body.data.accessToken);
    expect(customerDel.status).toBe(403);
  });

  it('updates scalars via PATCH and writes an audit log', async () => {
    const res = await request(app)
      .patch('/api/v1/admin/products/' + productId)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ name: 'CI Mgmt Product Renamed', price: 1599, status: 'DRAFT' });
    expect(res.status).toBe(200);

    const detail = await request(app)
      .get('/api/v1/admin/catalog/products/' + productId)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(detail.body.data.name).toBe('CI Mgmt Product Renamed');
    expect(detail.body.data.price).toBe(1599);
    expect(detail.body.data.status).toBe('DRAFT');

    const logs = await prisma.auditLog.findMany({
      where: { action: 'PRODUCT_UPDATED', entityId: productId },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(logs.length).toBeGreaterThan(0);
  });

  it('rejects a PATCH with an unknown categorySlug (400)', async () => {
    const res = await request(app)
      .patch('/api/v1/admin/products/' + productId)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ categorySlug: 'does-not-exist-' + stamp });
    expect(res.status).toBe(400);
  });

  it('replaces / reorders images via PATCH (remove one, add one)', async () => {
    // Start: [img1, img2]. Result: [newImg, img1] - img2 removed, new first.
    const res = await request(app)
      .patch('/api/v1/admin/products/' + productId)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        images: [
          { url: 'https://images.unsplash.com/photo-1622560480605-d83c85367e43?w=800&h=1000&fit=crop&q=80', alt: 'New primary' },
          { id: (await request(app).get('/api/v1/admin/catalog/products/' + productId).set('Authorization', 'Bearer ' + adminToken)).body.data.images[0].id, url: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=800&h=1000&fit=crop&q=80', alt: 'Kept image' },
        ],
      });
    expect(res.status).toBe(200);

    const detail = await request(app)
      .get('/api/v1/admin/catalog/products/' + productId)
      .set('Authorization', 'Bearer ' + adminToken);
    const images = detail.body.data.images as { url: string; alt: string | null; sortOrder: number }[];
    expect(images.length).toBe(2);
    expect(images[0].alt).toBe('New primary');
    expect(images[0].sortOrder).toBe(0);
    expect(images[1].alt).toBe('Kept image');
  });

  it('rejects a PATCH carrying an image id from another product (400)', async () => {
    // Seed products exist and have images; grab one of their image ids.
    const seeded = await prisma.product.findFirst({ where: { slug: 'kien-athlete-40l' }, include: { images: true } });
    expect(seeded).toBeTruthy();
    const foreignImageId = seeded!.images[0].id;
    const res = await request(app)
      .patch('/api/v1/admin/products/' + productId)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ images: [{ id: foreignImageId, url: 'https://example.com/x.jpg' }] });
    expect(res.status).toBe(400);
  });

  it('archives the product (idempotent) and audits it', async () => {
    const res = await request(app)
      .post('/api/v1/admin/products/' + productId + '/archive')
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ARCHIVED');
    const again = await request(app)
      .post('/api/v1/admin/products/' + productId + '/archive')
      .set('Authorization', 'Bearer ' + adminToken);
    expect(again.status).toBe(200);
    expect(again.body.data.status).toBe('ARCHIVED');
    const logs = await prisma.auditLog.findMany({ where: { action: 'PRODUCT_ARCHIVED', entityId: productId } });
    expect(logs.length).toBe(1); // second call must not re-audit
  });

  it('refuses to delete a product with order history (409, records intact)', async () => {
    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { sku } });
    const order = await prisma.order.create({
      data: {
        orderNumber: 'CI-MGMT-' + stamp,
        email: 'ci-mgmt-' + stamp + '@example.com',
        subtotalPaise: 149900,
        shippingPaise: 0,
        totalPaise: 149900,
        shippingAddress: { firstName: 'CI', lastName: 'Test', line1: '1 Test St', city: 'Mumbai', state: 'MH', pincode: '400001', phone: '9999999999' },
        items: {
          create: {
            variantId: variant.id,
            productName: 'CI Mgmt Product Renamed',
            productSlug: slug,
            sku,
            colorName: 'Matte Black',
            quantity: 1,
            unitPricePaise: 149900,
            lineTotalPaise: 149900,
          },
        },
      },
    });
    const res = await request(app)
      .delete('/api/v1/admin/products/' + productId)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRODUCT_HAS_ORDERS');
    expect(res.body.error.orderItemCount).toBe(1);

    const still = await prisma.product.findUnique({ where: { id: productId! } });
    expect(still).toBeTruthy();

    // cleanup: remove the order so the delete-path tests below can run on
    // products without history; this specific product stays for afterAll.
    await prisma.order.delete({ where: { id: order.id } });
  });

  it('deletes a product without order history, cascading children, and audits it', async () => {
    // Fresh product with a variant + inventory + movement.
    const res = await request(app)
      .post('/api/v1/admin/products')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        ...baseProduct,
        slug: slug + '-del',
        name: 'CI Mgmt Delete Product',
        variants: [{ sku: sku + '-D', colorName: 'Navy', colorHex: '#1a2a4a', inventoryQty: 3 }],
      });
    expect(res.status).toBe(201);
    const delId = res.body.data.id as string;
    const variantBefore = await prisma.productVariant.findUniqueOrThrow({ where: { sku: sku + '-D' } });

    const del = await request(app)
      .delete('/api/v1/admin/products/' + delId)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(del.status).toBe(200);
    expect(del.body.data.deleted).toBe(true);

    expect(await prisma.product.findUnique({ where: { id: delId } })).toBeNull();
    expect(await prisma.productVariant.findUnique({ where: { sku: sku + '-D' } })).toBeNull();
    expect(await prisma.inventory.findUnique({ where: { variantId: variantBefore.id } })).toBeNull();
    const logs = await prisma.auditLog.findMany({ where: { action: 'PRODUCT_DELETED', entityId: delId } });
    expect(logs.length).toBe(1);
  });

  it('401/403 on the image upload endpoint', async () => {
    const anon = await request(app)
      .post('/api/v1/admin/images')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('x'));
    expect(anon.status).toBe(401);
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'ci-mgmt-cust2-' + stamp + '@example.com', password: 'Password123', firstName: 'T', lastName: 'U' });
    expect(reg.status).toBe(201);
    const customer = await request(app)
      .post('/api/v1/admin/images')
      .set('Authorization', 'Bearer ' + reg.body.data.accessToken)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('x'));
    expect(customer.status).toBe(403);
  });

  it('rejects an empty upload with 400', async () => {
    const res = await request(app)
      .post('/api/v1/admin/images')
      .set('Authorization', 'Bearer ' + adminToken)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(0));
    expect(res.status).toBe(400);
  });

  it('rejects a non-image payload with 400 (magic-byte check)', async () => {
    const res = await request(app)
      .post('/api/v1/admin/images')
      .set('Authorization', 'Bearer ' + adminToken)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('this is definitely not an image'));
    expect(res.status).toBe(400);
  });

  it('rejects an image larger than 5 MB with 400', async () => {
    const res = await request(app)
      .post('/api/v1/admin/images')
      .set('Authorization', 'Bearer ' + adminToken)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(5 * 1024 * 1024 + 1, 0x89));
    expect(res.status).toBe(400);
  });

  it('reports 503 STORAGE_NOT_CONFIGURED when storage env vars are unset', async () => {
    // CI does not define CLOUDINARY_* vars, so the real implementation is
    // unconfigured by default.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const res = await request(app)
      .post('/api/v1/admin/images')
      .set('Authorization', 'Bearer ' + adminToken)
      .set('Content-Type', 'application/octet-stream')
      .send(png);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STORAGE_NOT_CONFIGURED');
  });

  it('accepts a valid PNG and returns the hosted url (fake storage injected)', async () => {
    const { __setStorageForTests } = await import('../../src/modules/admin/image.storage');
    const uploaded: Buffer[] = [];
    __setStorageForTests({
      configured: () => true,
      upload: async (buffer, _filename, mediaType) => {
        uploaded.push(buffer);
        return {
          url: 'https://res.cloudinary.com/test/' + (mediaType === 'VIDEO' ? 'video' : 'image') + '/upload/v1/kiensports/products/fake-' + uploaded.length,
          publicId: 'kiensports/products/fake-' + uploaded.length,
          resourceType: mediaType === 'VIDEO' ? 'video' : 'image',
          format: 'png',
        };
      },
      destroy: async () => undefined,
    });
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
      const res = await request(app)
        .post('/api/v1/admin/images?filename=test.png')
        .set('Authorization', 'Bearer ' + adminToken)
        .set('Content-Type', 'application/octet-stream')
        .send(png);
      expect(res.status).toBe(201);
      expect(String(res.body.data.url)).toContain('https://res.cloudinary.com/test/');
      expect(uploaded.length).toBe(1);
      expect(uploaded[0].length).toBe(png.length); // full bytes reached storage
    } finally {
      __setStorageForTests(null);
    }
  });
});
