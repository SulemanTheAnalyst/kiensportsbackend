import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://kien:kien@localhost:5432/kiensports';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'unit-test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'unit-test-refresh-secret';

import {
  contactSupportNotification,
  escapeHtml,
  orderConfirmationEmail,
  passwordResetEmail,
} from '../../src/modules/email/email.templates';

describe('email templates', () => {
  it('escapes HTML in customer-supplied contact fields (XSS / header-injection defense)', () => {
    const evil = '<script>alert(1)</script>"onmouseover=alert(2)';
    const email = contactSupportNotification({ id: 'x', name: evil, email: 'a@b.com', subject: 'order', message: evil });
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('&lt;script&gt;');
    expect(email.text).not.toContain('&lt;'); // plain text stays readable
  });

  it('produces both HTML and plain-text parts for every template', () => {
    const order = {
      orderNumber: 'KIEN-2026-000001-ABCDEF',
      placedAt: new Date('2026-10-15T10:00:00Z'),
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
      email: 'customer@example.com',
      items: [{ productName: 'Athlete 40L Backpack', colorName: 'Black', size: null, quantity: 1, unitPricePaise: 499900, lineTotalPaise: 499900 }],
      subtotalPaise: 499900,
      shippingPaise: 0,
      taxPaise: 0,
      totalPaise: 499900,
      shippingAddress: { firstName: 'Test', lastName: 'User', line1: '1 Road', city: 'Patna', state: 'Bihar', pincode: '800006', phone: '+919999999999' },
      shipment: null,
    };
    const confirmation = orderConfirmationEmail(order);
    expect(confirmation.html).toContain(order.orderNumber);
    expect(confirmation.text).toContain(order.orderNumber);
    expect(confirmation.text).toContain('Athlete 40L Backpack');
    const reset = passwordResetEmail({ email: 'a@b.com', resetUrl: 'https://kiensports.com/account/reset?token=t'.repeat(1), ttlMinutes: 60 });
    expect(reset.html).toContain('https://kiensports.com/account/reset?token=t');
    expect(reset.text).toContain('60 minutes');
  });

  it('escapeHtml neutralizes quotes and angle brackets', () => {
    expect(escapeHtml('<a href="x">')).toBe('&lt;a href=&quot;x&quot;&gt;');
  });
});
