import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';

// Integration test: requires a running Postgres (docker compose up -d db)
// and a migrated+seeded database (npm run db:migrate && npm run db:seed).
// Skips automatically when DATABASE_URL is not configured.

// Covers the admin read-side endpoints added for the admin panel:
// - src/modules/admin/admin.reports.routes.ts (dashboard, orders, customers,
//   payments, shipments, inventory, movements)
// - src/modules/admin/admin.catalog.routes.ts (catalog/products)
// Authorization is enforced by the backend for every route: an anonymous
// request must receive 401 and an authenticated CUSTOMER must receive 403.

const run = process.env.DATABASE_URL ? describe : describe.skip;

const ADMIN_READ_ENDPOINTS = [
  '/admin/dashboard/summary',
  '/admin/catalog/products',
  '/admin/inventory',
  '/admin/inventory/movements',
  '/admin/customers',
  '/admin/payments',
  '/admin/shipments',
];

run('admin read endpoints (authorization)', () => {
  let app: import('express').Express;

  beforeAll(async () => {
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    const { createApp } = await import('../../src/app');
    app = createApp();
  });

  it('requires authentication (401 without a token)', async () => {
    for (const path of ADMIN_READ_ENDPOINTS) {
      const res = await request(app).get('/api/v1' + path);
      expect(res.status).toBe(401);
      expect(res.body.error).toBeTruthy();
    }
  });

  it('requires the ADMIN role (403 for a CUSTOMER token)', async () => {
    const email = 'admcust-' + Date.now() + '@example.com';
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Password123', firstName: 'Test', lastName: 'User' });
    expect(reg.status).toBe(201);
    const token = reg.body.data.accessToken as string;

    for (const path of ADMIN_READ_ENDPOINTS) {
      const res = await request(app)
        .get('/api/v1' + path)
        .set('Authorization', 'Bearer ' + token);
      expect(res.status).toBe(403);
      expect(res.body.error).toBeTruthy();
    }
  });

  it('requires the ADMIN role for order detail lookups (403/404, never 200 for customers)', async () => {
    const email = 'admcust2-' + Date.now() + '@example.com';
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'Password123', firstName: 'Test', lastName: 'User' });
    const token = reg.body.data.accessToken as string;
    const res = await request(app)
      .get('/api/v1/admin/orders/DOES-NOT-EXIST')
      .set('Authorization', 'Bearer ' + token);
    expect(res.status).toBe(403);
  });
});
