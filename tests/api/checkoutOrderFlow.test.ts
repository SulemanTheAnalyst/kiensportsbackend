import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

// Integration test: requires a running Postgres (docker compose up -d db)
// and a migrated database (npx prisma db push). Skips automatically when
// DATABASE_URL is not configured. No real payment provider or Cloudinary
// credentials are involved: the CI provider is the sandbox mock gateway.
//
// Regression coverage for the checkout bug-fix batch:
//  1. guests can browse and fill a cart, but POST /orders requires auth (401)
//  2. the customer identity comes from the verified token, not the body
//  3. invalid payloads are rejected with 400 VALIDATION_ERROR + details
//  4. a valid authenticated checkout creates exactly one order (201) with
//     server-side prices and the authenticated user id
//  5. cart/order thumbnails only ever use IMAGE media (never a video URL)
//     even when a VIDEO row sorts first, and prefer the item's colour image

const run = process.env.DATABASE_URL ? describe : describe.skip;

run('checkout order flow: auth, validation, media thumbnails (integration)', () => {
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
    // Non-destructive cleanup: only rows this test file created.
    for (const id of created.orderIds) {
      await prisma.order.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of created.userIds) {
      await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of created.productIds) {
      await prisma.product.delete({ where: { id } }).catch(() => undefined);
    }
    for (const id of created.categoryIds) {
      await prisma.category.delete({ where: { id } }).catch(() => undefined);
    }
  });

  const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // Self-contained catalog row: variant priced at Rs 1499 (product base price
  // is deliberately different to prove the server charges the VARIANT price),
  // with a VIDEO media row sorting FIRST and colour-matched IMAGE rows after.
  const makeProduct = async () => {
    const stamp = uniq();
    const category = await prisma.category.create({
      data: { slug: 'cat-' + stamp, name: 'Test Category ' + stamp, world: 'sport', description: 'test' },
    });
    created.categoryIds.push(category.id);
    const product = await prisma.product.create({
      data: {
        slug: 'prod-' + stamp, name: 'Test Backpack ' + stamp, shortDescription: 's', description: 'd',
        categoryId: category.id, pricePaise: 100, compareAtPaise: 199900, status: 'ACTIVE',
        variants: { create: { sku: 'SKU-' + stamp, colorName: 'Black', colorHex: '#000000', pricePaise: 149900 } },
        images: {
          create: [
            // VIDEO sorts first - must NEVER become a cart thumbnail.
            { url: 'https://media.example.com/video-' + stamp + '.mp4', mediaType: 'VIDEO', resourceType: 'video', format: 'mp4', sortOrder: 0, alt: 'demo video' },
            { url: 'https://media.example.com/other-' + stamp + '.jpg', mediaType: 'IMAGE', sortOrder: 1, colorName: 'Green' },
            { url: 'https://media.example.com/black-' + stamp + '.jpg', mediaType: 'IMAGE', sortOrder: 2, colorName: 'Black' },
          ],
        },
      },
    });
    created.productIds.push(product.id);
    const variant = await prisma.productVariant.findFirstOrThrow({ where: { productId: product.id } });
    await prisma.inventory.create({ data: { variantId: variant.id, availableQty: 10, reservedQty: 0, soldQty: 0 } });
    return { product, variant };
  };

  const registerUser = async () => {
    const stamp = uniq();
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: `checkout-${stamp}@example.com`, password: 'Passw0rd!ex', firstName: 'Test', lastName: 'User' });
    expect(res.status).toBe(201);
    const userId = res.body.data.user.id;
    created.userIds.push(userId);
    return { token: res.body.data.accessToken as string, userId, email: `checkout-${stamp}@example.com` };
  };

  const validAddress = {
    firstName: 'Test', lastName: 'User', line1: '1 Test Street',
    city: 'Bengaluru', state: 'Karnataka', pincode: '560001', phone: '9876543210',
  };

  it('rejects order creation without authentication (401) and creates no order', async () => {
    const { variant } = await makeProduct();
    const guest = request.agent(app);
    // A guest CAN add items to the cart (guest browsing stays allowed).
    const add = await guest.post('/api/v1/cart/items').send({ variantId: variant.id, quantity: 1 });
    expect(add.status).toBe(201);

    const res = await guest.post('/api/v1/orders').send({
      email: 'guest@example.com', address: validAddress, paymentMethod: 'COD',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
    const orders = await prisma.order.findMany({ where: { email: 'guest@example.com' } });
    expect(orders.length).toBe(0);
  });

  it('rejects an invalid shipping payload with 400 and per-field details', async () => {
    const { variant } = await makeProduct();
    const { token } = await registerUser();
    const agent = request.agent(app);
    const add = await agent
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ variantId: variant.id, quantity: 1 });
    expect(add.status).toBe(201);

    const res = await agent
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: 'not-an-email',
        address: { ...validAddress, pincode: '1234', phone: '12345' },
        paymentMethod: 'CARD',
      });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.error?.details)).toBe(true);
    const paths = (res.body.error?.details as { path: string }[]).map((d) => d.path);
    expect(paths.some((p) => p.includes('email'))).toBe(true);
    expect(paths.some((p) => p.includes('pincode'))).toBe(true);
    expect(paths.some((p) => p.includes('phone'))).toBe(true);
  });

  it('creates exactly one order for an authenticated customer with server-side prices', async () => {
    const { product, variant } = await makeProduct();
    const { token, userId, email } = await registerUser();
    const agent = request.agent(app);
    const add = await agent
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ variantId: variant.id, quantity: 1 });
    expect(add.status).toBe(201);

    const res = await agent
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({ email, address: validAddress, paymentMethod: 'COD' });
    expect(res.status).toBe(201);

    const order = res.body.data.order;
    created.orderIds.push(order.id);
    expect(order.userId ?? undefined).toBeTruthy();
    const stored = await prisma.order.findFirstOrThrow({ where: { id: order.id }, include: { items: true } });
    expect(stored.userId).toBe(userId); // identity from the token, not the body
    // Server-side pricing: the VARIANT price (Rs 1499), not the browser price
    // and not the product's Rs 1 base price.
    expect(stored.items[0].unitPricePaise).toBe(149900);
    expect(stored.totalPaise).toBe(149900 + 9900); // Rs 99 flat shipping under Rs 2000
    expect(stored.items[0].productName).toBe(product.name);
  });

  it('cart thumbnails only use IMAGE media, preferring the item colour', async () => {
    const { variant } = await makeProduct();
    const { token } = await registerUser();
    const agent = request.agent(app);
    const add = await agent
      .post('/api/v1/cart/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ variantId: variant.id, quantity: 1 });
    expect(add.status).toBe(201);

    const res = await agent.get('/api/v1/cart').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const item = res.body.data.items.find((i: { variantId: string }) => i.variantId === variant.id);
    expect(item).toBeDefined();
    expect(item.image).toBeDefined();
    expect(String(item.image)).not.toContain('.mp4');        // never a video URL
    expect(String(item.image)).toContain('black-');          // colour-matched IMAGE row
  });
});
