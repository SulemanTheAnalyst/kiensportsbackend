import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';

// Integration test: requires a running Postgres (docker compose up -d db)
// and a migrated+seeded database (npm run db:migrate && npm run db:seed).
// Skips automatically when TEST_DATABASE_URL is not configured.

const run = process.env.DATABASE_URL ? describe : describe.skip;

run('catalog + cart + auth API (integration)', () => {
  let app: import('express').Express;

  beforeAll(async () => {
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    const { createApp } = await import('../../src/app');
    app = createApp();
  });

  it('health endpoint responds', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
  });

  it('lists the seeded catalog with 3 active products', async () => {
    const res = await request(app).get('/api/v1/products');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(3);
    const slugs = res.body.data.data.map((p: { slug: string }) => p.slug);
    expect(slugs).toContain('kien-athlete-40l');
    expect(slugs).toContain('kien-duffel');
    expect(slugs).toContain('kien-lifestyle-sling');
  });

  it('returns frontend-shaped products (price in rupees, colors with images)', async () => {
    const res = await request(app).get('/api/v1/products/kien-athlete-40l');
    expect(res.status).toBe(200);
    const p = res.body.data;
    expect(p.price).toBe(4999);
    expect(p.category).toBe('sport');
    expect(p.colors.length).toBe(2);
    expect(p.features.length).toBe(8);
    expect(typeof p.inStock).toBe('boolean');
  });

  it('filters by world (sport has 2, lifestyle has 1)', async () => {
    const sport = await request(app).get('/api/v1/products?category=sport');
    const lifestyle = await request(app).get('/api/v1/products?category=lifestyle');
    expect(sport.body.data.total).toBe(2);
    expect(lifestyle.body.data.total).toBe(1);
  });

  it('searches by keyword', async () => {
    const res = await request(app).get('/api/v1/search?q=backpack');
    expect(res.status).toBe(200);
    expect(res.body.data.some((p: { slug: string }) => p.slug === 'kien-athlete-40l')).toBe(true);
  });

  it('rejects invalid cart additions with a validation error', async () => {
    const res = await request(app).post('/api/v1/cart/items').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('registers a customer and returns an access token + refresh cookie', async () => {
    const email = 'it-' + Date.now() + '@example.com';
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Password123', firstName: 'Test', lastName: 'User' });
    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.headers['set-cookie'].some((c: string) => c.startsWith('kien_refresh'))).toBe(true);
  });

  it('does not allow duplicate registration', async () => {
    const email = 'dup-' + Date.now() + '@example.com';
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Password123', firstName: 'Test', lastName: 'User' });
    const dup = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Password123', firstName: 'Test', lastName: 'User' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('refuses unauthenticated access to account endpoints', async () => {
    const res = await request(app).get('/api/v1/account');
    expect(res.status).toBe(401);
  });

  it('refuses non-admin access to admin endpoints', async () => {
    const email = 'cust-' + Date.now() + '@example.com';
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Password123', firstName: 'Test', lastName: 'User' });
    const token = reg.body.data.accessToken as string;
    const res = await request(app)
      .get('/api/v1/admin/products')
      .set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(403);
  });
});
