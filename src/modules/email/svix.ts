import { createHmac, timingSafeEqual } from 'crypto';

// Svix webhook signature verification (Resend signs all webhook deliveries,
// including inbound email.received, with the Svix scheme).
//
// Signature: base64(HMAC-SHA256(secret, "${id}.${timestamp}.${rawBody}"))
// presented as "v1,<signature>" (space-separated list allows multi-sig during
// secret rotation). The secret is "whsec_" + base64 key material; the prefix is
// a label, not part of the key. A 5-minute timestamp tolerance limits replay.
//
// Pure function, no env/process access: testable in isolation. The caller is
// responsible for passing the exact raw request body bytes.

export interface SvixHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

const TOLERANCE_SECONDS = 300;

export const verifySvixSignature = (args: {
  secret: string;
  payload: string;
  headers: Partial<SvixHeaders>;
}): boolean => {
  const { secret, payload, headers } = args;
  if (!headers.id || !headers.timestamp || !headers.signature) return false;

  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TOLERANCE_SECONDS) return false;

  const secretBase64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(secretBase64, 'base64');
  } catch {
    return false;
  }
  if (key.length === 0) return false;

  const signedContent = headers.id + '.' + headers.timestamp + '.' + payload;
  const expected = createHmac('sha256', key).update(signedContent).digest('base64');

  for (const part of headers.signature.split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    const a = Buffer.from(value);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
};

// Helper to compute a valid signature (used by tests and local tooling).
export const signSvixPayload = (secret: string, id: string, timestamp: number, payload: string): string => {
  const secretBase64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = Buffer.from(secretBase64, 'base64');
  const sig = createHmac('sha256', key).update(id + '.' + timestamp + '.' + payload).digest('base64');
  return 'v1,' + sig;
};
