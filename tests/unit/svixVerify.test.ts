import { describe, expect, it } from 'vitest';
import { signSvixPayload, verifySvixSignature } from '../../src/modules/email/svix';

// Svix signature verification is the security-critical path of the Resend
// inbound webhook. These tests mirror the documented scheme:
// base64(HMAC-SHA256(base64decode("whsec_" prefix stripped), id.ts.payload)).

const SECRET = 'whsec_' + Buffer.from('unit-test-signing-secret').toString('base64');
const payload = JSON.stringify({ type: 'email.received', data: { email_id: 'abc' } });
const id = 'msg_123';
const now = Math.floor(Date.now() / 1000);

describe('svix signature verification', () => {
  it('accepts a correctly signed payload', () => {
    const signature = signSvixPayload(SECRET, id, now, payload);
    expect(verifySvixSignature({ secret: SECRET, payload, headers: { id, timestamp: String(now), signature } })).toBe(true);
  });

  it('accepts a multi-signature header (secret rotation window)', () => {
    const old = signSvixPayload('whsec_' + Buffer.from('old-secret').toString('base64'), id, now, payload);
    const current = signSvixPayload(SECRET, id, now, payload);
    expect(
      verifySvixSignature({ secret: SECRET, payload, headers: { id, timestamp: String(now), signature: old + ' ' + current } }),
    ).toBe(true);
  });

  it('rejects an invalid signature', () => {
    expect(
      verifySvixSignature({ secret: SECRET, payload, headers: { id, timestamp: String(now), signature: 'v1,AAAAinvalidAAAA' } }),
    ).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifySvixSignature({ secret: SECRET, payload, headers: { timestamp: String(now), signature: 'v1,x' } })).toBe(false);
    expect(verifySvixSignature({ secret: SECRET, payload, headers: {} })).toBe(false);
  });

  it('rejects a stale timestamp (replay protection)', () => {
    const stale = now - 3600;
    const signature = signSvixPayload(SECRET, id, stale, payload);
    expect(verifySvixSignature({ secret: SECRET, payload, headers: { id, timestamp: String(stale), signature } })).toBe(false);
  });

  it('rejects a payload signed with a different secret', () => {
    const signature = signSvixPayload('whsec_' + Buffer.from('other-secret').toString('base64'), id, now, payload);
    expect(verifySvixSignature({ secret: SECRET, payload, headers: { id, timestamp: String(now), signature } })).toBe(false);
  });

  it('rejects tampered payload bytes', () => {
    const signature = signSvixPayload(SECRET, id, now, payload);
    expect(verifySvixSignature({ secret: SECRET, payload: payload + 'x', headers: { id, timestamp: String(now), signature } })).toBe(false);
  });
});
