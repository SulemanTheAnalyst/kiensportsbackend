import { describe, expect, it, vi, beforeEach } from 'vitest';

// The email service must never crash flows when the provider is down or
// unconfigured. The Resend SDK is mocked - no network, no real emails.

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://kien:kien@localhost:5432/kiensports';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'unit-test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'unit-test-refresh-secret';
process.env.PAYMENT_PROVIDER = 'mock';

const sendMock = vi.fn();
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}));
vi.mock('../../src/lib/prisma', () => ({
  prisma: { orderStatusEvent: { findFirst: vi.fn(), create: vi.fn() } },
}));

describe('email service', () => {
  beforeEach(() => {
    sendMock.mockReset();
    vi.resetModules();
  });

  it('reports not-configured instead of throwing when RESEND_API_KEY is unset', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendEmail } = await import('../../src/modules/email/email.service');
    const result = await sendEmail({ to: 'customer@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' });
    expect(result.accepted).toBe(false);
    expect(result.error).toBe('NOT_CONFIGURED');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('reports acceptance when the provider accepts the message', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    sendMock.mockResolvedValueOnce({ data: { id: 'email-123' }, error: null });
    const { sendEmail } = await import('../../src/modules/email/email.service');
    const result = await sendEmail({ to: 'customer@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', replyTo: 'reply@example.com' });
    expect(result.accepted).toBe(true);
    expect(result.providerId).toBe('email-123');
    const call = sendMock.mock.calls[0][0];
    expect(call.replyTo).toBe('reply@example.com'); // Reply-To = customer's address
    expect(call.to[0]).toBe('customer@example.com');
  });

  it('swallows provider API failures without throwing', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    sendMock.mockRejectedValueOnce(new Error('network down'));
    const { sendEmail } = await import('../../src/modules/email/email.service');
    const result = await sendEmail({ to: 'customer@example.com', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' });
    expect(result.accepted).toBe(false);
    expect(result.error).toBe('PROVIDER_FAILURE');
  });

  it('reports provider rejections (accepted != delivered semantics preserved)', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    sendMock.mockResolvedValueOnce({ data: null, error: { name: 'validation_error', message: 'invalid to' } });
    const { sendEmail } = await import('../../src/modules/email/email.service');
    const result = await sendEmail({ to: 'not-an-email', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' });
    expect(result.accepted).toBe(false);
    expect(result.error).toBe('validation_error');
  });

  it('never sends twice for the same order email kind (duplicate replay guard)', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    sendMock.mockResolvedValue({ data: { id: 'email-x' }, error: null });
    const { sendOrderEmailOnce } = await import('../../src/modules/email/email.service');
    const { prisma } = await import('../../src/lib/prisma');
    (prisma.orderStatusEvent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const send = vi.fn().mockResolvedValue({ accepted: true, providerId: 'email-x' });
    await sendOrderEmailOnce('ORDER_CONFIRMED', 'order-1', undefined, send);
    // Second delivery of the same event: marker row found -> skipped.
    (prisma.orderStatusEvent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'marker' });
    const send2 = vi.fn();
    const second = await sendOrderEmailOnce('ORDER_CONFIRMED', 'order-1', undefined, send2);
    expect(second.skipped).toBe(true);
    expect(send2).not.toHaveBeenCalled();
  });

  it('does not create a marker when the send failed (safe retry)', async () => {
    process.env.RESEND_API_KEY = 're_test_key';
    const { sendOrderEmailOnce } = await import('../../src/modules/email/email.service');
    const { prisma } = await import('../../src/lib/prisma');
    (prisma.orderStatusEvent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.orderStatusEvent.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const send = vi.fn().mockResolvedValue({ accepted: false, error: 'PROVIDER_FAILURE' });
    const result = await sendOrderEmailOnce('ORDER_SHIPPED', 'order-1', undefined, send);
    expect(result.accepted).toBe(false);
    expect(prisma.orderStatusEvent.create).not.toHaveBeenCalled();
  });
});
