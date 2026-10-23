import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { Express } from 'express';

// Integration tests for the business Settings centre (admin API).
//  - authorization: unauthenticated and non-admin users are refused;
//  - validation: invalid values are rejected by zod before any write;
//  - persistence: saved settings change backend-enforced pricing (the cart
//    quote reads the same configuration after cache invalidation);
//  - audit: sensitive changes are audit-logged;
//  - privacy: no credentials are ever returned by the API.

const run = process.env.DATABASE_URL ? describe : describe.skip;

run('Admin settings centre (integration)', () => {
  let app: Express;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  const created: { userIds: string[] } = { userIds: [] };

  beforeAll(async () => {
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    const mod = await import('../../src/app');
    app = mod.createApp();
    const prismaMod = await import('../../src/lib/prisma');
    prisma = prismaMod.prisma;
  });

  afterAll(async () => {
    // Restore environment defaults for every later test file: the singleton
    // row is removed so resolved settings fall back to the env defaults.
    await prisma.businessSettings.delete({ where: { id: 'singleton' } }).catch(() => undefined);
    for (const id of created.userIds) await prisma.user.delete({ where: { id } }).catch(() => undefined);
  });

  const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const registerCustomer = async () => {
    const stamp = uniq();
    const email = 'cust-' + stamp + '@example.com';
    const reg = await request(app).post('/api/v1/auth/register').send({
      email, password: 'Password123', firstName: 'Cust', lastName: 'Test',
    });
    const user = await prisma.user.findUnique({ where: { email } });
    created.userIds.push(user.id);
    return reg.body.data.accessToken as string;
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

  it('refuses unauthenticated and non-admin access to every settings route', async () => {
    const anon = await request(app).get('/api/v1/admin/settings');
    expect(anon.status).toBe(401);

    const cust = await registerCustomer();
    const asCustomer = await request(app).get('/api/v1/admin/settings').set('Authorization', 'Bearer ' + cust);
    expect(asCustomer.status).toBe(403);

    const putAnon = await request(app).put('/api/v1/admin/settings').send({ brandName: 'X' });
    expect(putAnon.status).toBe(401);

    const healthAnon = await request(app).get('/api/v1/admin/settings/health');
    expect(healthAnon.status).toBe(401);

    const notifAnon = await request(app).get('/api/v1/admin/settings/notifications');
    expect(notifAnon.status).toBe(401);
  });

  it('returns resolved settings with business defaults and no secrets', async () => {
    const admin = await adminToken();
    const res = await request(app).get('/api/v1/admin/settings').set('Authorization', 'Bearer ' + admin);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.brandName).toBe('KIEN Sports');
    expect(data.currency).toBe('INR');
    expect(data.timezone).toBe('Asia/Kolkata');
    expect(data.websiteUrl).toBe('https://kiensports.com');
    expect(typeof data.codEnabled).toBe('boolean');
    expect(typeof data.flatShippingRupees).toBe('number');

    // Privacy: no credential-ish keys are ever part of the payload.
    const keys = Object.keys(data);
    for (const k of keys) {
      expect(k.toLowerCase()).not.toContain('secret');
      expect(k.toLowerCase()).not.toContain('password');
      expect(k.toLowerCase()).not.toContain('apikey');
      expect(k.toLowerCase()).not.toContain('key');
    }
  });

  it('rejects invalid values with 400 and does not write anything', async () => {
    const admin = await adminToken();
    const bad = await request(app).put('/api/v1/admin/settings').set('Authorization', 'Bearer ' + admin).send({
      websiteUrl: 'not a url',
    });
    expect(bad.status).toBe(400);

    const badNegative = await request(app).put('/api/v1/admin/settings').set('Authorization', 'Bearer ' + admin).send({
      flatShippingRupees: -5,
    });
    expect(badNegative.status).toBe(400);

    // Unknown fields are dropped (whitelist) - no arbitrary column writes.
    const ghost = await request(app).put('/api/v1/admin/settings').set('Authorization', 'Bearer ' + admin).send({
      totallyUnknownField: 'x',
    });
    expect(ghost.status).toBe(200);
    expect(ghost.body.data.savedFields).toEqual([]);
  });

  it('saves valid settings, invalidates the cache, and changes backend pricing', async () => {
    const admin = await adminToken();

    const put = await request(app).put('/api/v1/admin/settings').set('Authorization', 'Bearer ' + admin).send({
      brandName: 'KIEN Sports',
      supportEmail: 'support@kiensports.com',
      flatShippingRupees: 150,
      freeShippingThresholdRupees: 5000,
      codEnabled: true,
    });
    expect(put.status).toBe(200);
    expect(put.body.data.savedFields).toContain('flatShippingPaise');

    const get = await request(app).get('/api/v1/admin/settings').set('Authorization', 'Bearer ' + admin);
    expect(get.status).toBe(200);
    expect(get.body.data.saved).toBe(true);
    expect(get.body.data.flatShippingRupees).toBe(150);
    expect(get.body.data.freeShippingThresholdRupees).toBe(5000);
    expect(get.body.data.supportEmail).toBe('support@kiensports.com');

    // Audit log records the change (field names only).
    const log = await prisma.auditLog.findFirst({ where: { action: 'SETTINGS_UPDATED' }, orderBy: { createdAt: 'desc' } });
    expect(log).not.toBeNull();
    expect(log.details.fields).toContain('flatShippingPaise');

    // The backend-enforced pricing (cart quote) reflects the new settings
    // immediately: the admin API speaks rupees, storage is paise.
    const agent = request.agent(app);
    const summary = await agent.get('/api/v1/cart/quote');
    expect(summary.status).toBe(200);
    expect(summary.body.data.shipping).toBe(150);
    expect(summary.body.data.freeShippingThreshold).toBe(5000);
  });

  it('rejects a COD minimum above the COD maximum', async () => {
    const admin = await adminToken();
    const res = await request(app).put('/api/v1/admin/settings').set('Authorization', 'Bearer ' + admin).send({
      codMinOrderRupees: 5000,
      codMaxOrderRupees: 1000,
    });
    expect(res.status).toBe(400);
  });

  it('reports integration health statuses and notification history safely', async () => {
    const admin = await adminToken();

    const health = await request(app).get('/api/v1/admin/settings/health').set('Authorization', 'Bearer ' + admin);
    expect(health.status).toBe(200);
    const h = health.body.data;
    expect(['connected', 'error']).toContain(h.database);
    expect(['connected', 'configuration_required']).toContain(h.email);
    expect(['connected', 'configuration_required']).toContain(h.payments.status);
    // No backup monitoring exists: never claim a backup.
    expect(h.backups).toBe('not_configured');

    const notif = await request(app).get('/api/v1/admin/settings/notifications').set('Authorization', 'Bearer ' + admin);
    expect(notif.status).toBe(200);
    expect(Array.isArray(notif.body.data.events)).toBe(true);
    for (const e of notif.body.data.events) {
      // Payloads contain customer contact details and must never be exposed.
      expect(e.payload).toBeUndefined();
      expect(e.dedupeKey).toBeDefined();
      expect(e.type).toBeDefined();
    }
  });
});
