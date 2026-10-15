import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';

// Integration test: requires a running Postgres (docker compose up -d db),
// like the existing API tests. Skips automatically without DATABASE_URL.
// Covers the Resend inbound webhook: signature verification, duplicate
// deliveries, event-type validation and malformed payloads. No email is
// actually sent (RESEND_API_KEY unset -> sending disabled).

const run = process.env.DATABASE_URL ? describe : describe.skip;

const SECRET = 'whsec_' + Buffer.from('webhook-test-signing-secret').toString('base64');
process.env.RESEND_WEBHOOK_SECRET = SECRET;

run('resend inbound webhook', () => {
  let app: import('express').Express;
  let sign: (id: string, ts: number, body: string) => string;

  beforeAll(async () => {
    process.env.NODE_ENV = process.env.NODE_ENV || 'test';
    const { createApp } = await import('../../src/app');
    app = createApp();
    const { signSvixPayload } = await import('../../src/modules/email/svix');
    sign = (id: string, ts: number, body: string) => signSvixPayload(SECRET, id, ts, body);
  });

  const inboundUrl = '/api/v1/webhooks/resend/inbound';
  const now = () => Math.floor(Date.now() / 1000);

  const emailEvent = (emailId: string) =>
    JSON.stringify({
      type: 'email.received',
      created_at: '2026-10-15T09:00:00.000Z',
      data: {
        email_id: emailId,
        from: 'customer@example.com',
        to: ['support@kiensports.com'],
        cc: [],
        bcc: [],
        subject: 'Question about my order',
        attachments: [{ id: 'att_1', filename: 'receipt.pdf', content_type: 'application/pdf' }],
      },
    });

  it('accepts a valid signed email.received event (200) and stores it', async () => {
    const body = emailEvent('evt-' + Date.now() + '-a');
    const res = await request(app)
      .post(inboundUrl)
      .set('svix-id', 'msg-a')
      .set('svix-timestamp', String(now()))
      .set('svix-signature', sign('msg-a', now(), body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
  });

  it('acknowledges duplicate deliveries without reprocessing', async () => {
    const emailId = 'evt-' + Date.now() + '-dup';
    const body = emailEvent(emailId);
    const headers = {
      'svix-id': 'msg-dup',
      'svix-timestamp': String(now()),
    };
    const first = await request(app)
      .post(inboundUrl)
      .set(headers)
      .set('svix-signature', sign('msg-dup', Number(headers['svix-timestamp']), body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(inboundUrl)
      .set('svix-id', 'msg-dup-2')
      .set('svix-timestamp', String(now()))
      .set('svix-signature', sign('msg-dup-2', now(), body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body.data.duplicate).toBe(true);
  });

  it('rejects an invalid signature (400)', async () => {
    const body = emailEvent('evt-reject-1');
    const res = await request(app)
      .post(inboundUrl)
      .set('svix-id', 'msg-bad')
      .set('svix-timestamp', String(now()))
      .set('svix-signature', 'v1,tamperedsignature==')
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('rejects a missing signature header (400)', async () => {
    const body = emailEvent('evt-reject-2');
    const res = await request(app).post(inboundUrl).set('svix-id', 'msg-no-sig').set('svix-timestamp', String(now())).set('Content-Type', 'application/json').send(body);
    expect(res.status).toBe(400);
  });

  it('rejects a valid signature over malformed JSON (400)', async () => {
    const body = 'not-json{{{';
    const res = await request(app)
      .post(inboundUrl)
      .set('svix-id', 'msg-malformed')
      .set('svix-timestamp', String(now()))
      .set('svix-signature', sign('msg-malformed', now(), body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
  });

  it('acknowledges but ignores unexpected event types', async () => {
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'x', from: 'a@b.c', to: ['d@e.f'], subject: 's' } });
    const res = await request(app)
      .post(inboundUrl)
      .set('svix-id', 'msg-other')
      .set('svix-timestamp', String(now()))
      .set('svix-signature', sign('msg-other', now(), body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.data.ignored).toBe(true);
  });

  it('requires the frontend to expose no server secrets: /health reports only a boolean', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(typeof res.body.data.email.sendingConfigured).toBe('boolean');
    expect(JSON.stringify(res.body)).not.toMatch(/re_|whsec_/);
  });
});
