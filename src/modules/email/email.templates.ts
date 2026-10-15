import { env } from '../../config/env';

// Branded KIEN Sports email templates: responsive, inline-styled, HTML +
// plain-text pairs. All customer-supplied values are escaped - email bodies
// never render untrusted HTML. Business details below already exist on the
// public website (ContactPage) - nothing is invented here.

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const rupees = (paise: number): string =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(paise / 100);

const BRAND = { name: 'KIEN Sports', tagline: 'Built For Performance', site: 'https://kiensports.com' };

const wrap = (opts: { preheader: string; bodyHtml: string }): string => {
  const support = escapeHtml(env.SUPPORT_EMAIL);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KIEN Sports</title></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Helvetica,Arial,sans-serif;color:#111;">
  <div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(opts.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;">
        <tr><td style="padding:28px 32px;border-bottom:3px solid #111;">
          <span style="font-size:22px;font-weight:900;letter-spacing:2px;">KIEN</span>
          <span style="display:block;font-size:10px;letter-spacing:3px;color:#777;text-transform:uppercase;">${BRAND.tagline}</span>
        </td></tr>
        <tr><td style="padding:32px;font-size:14px;line-height:1.6;">${opts.bodyHtml}</td></tr>
        <tr><td style="padding:24px 32px;border-top:1px solid #eee;font-size:11px;color:#777;line-height:1.7;">
          <strong style="color:#111;">KIEN Sports Private Limited</strong><br>
          <a href="mailto:${support}" style="color:#555;">${support}</a> &middot;
          <a href="${BRAND.site}" style="color:#555;">kiensports.com</a><br>
          Built For Performance.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
};

export interface EmailContent { subject: string; html: string; text: string }

// ---- Contact form ----

export const contactSupportNotification = (m: {
  id: string; name: string; email: string; subject: string; message: string;
}): EmailContent => {
  const subject = '[KIEN Contact] ' + m.subject.toUpperCase() + ' - ' + m.name;
  const html = `<p style="margin:0 0 12px;">New contact message received through kiensports.com.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;width:100%;">
  <tr><td style="padding:6px 0;color:#777;width:110px;">Name</td><td>${escapeHtml(m.name)}</td></tr>
  <tr><td style="padding:6px 0;color:#777;">Email</td><td><a href="mailto:${escapeHtml(m.email)}">${escapeHtml(m.email)}</a></td></tr>
  <tr><td style="padding:6px 0;color:#777;">Subject</td><td>${escapeHtml(m.subject)}</td></tr>
</table>
<p style="margin:16px 0 6px;font-weight:600;">Message</p>
<p style="margin:0;white-space:pre-wrap;border:1px solid #eee;padding:14px;">${escapeHtml(m.message)}</p>
<p style="margin:14px 0 0;font-size:12px;color:#777;">Reply directly to this email to answer the customer (Reply-To is set to their address).</p>`;
  const text = [
    'New contact message received through kiensports.com.',
    '', 'Name: ' + m.name, 'Email: ' + m.email, 'Subject: ' + m.subject, '', 'Message:', m.message,
  ].join('\n');
  return { subject, html: wrap({ preheader: 'New contact message from ' + m.name, bodyHtml: html }), text };
};

export const contactCustomerConfirmation = (m: { name: string; subject: string }): EmailContent => {
  const support = escapeHtml(env.SUPPORT_EMAIL);
  const html = `<p style="margin:0 0 12px;">Hi ${escapeHtml(m.name)},</p>
<p style="margin:0 0 12px;">We have received your message and our team will get back to you shortly. You wrote to us about: <strong>${escapeHtml(m.subject)}</strong>.</p>
<p style="margin:0 0 12px;">If you need to add anything, simply reply to this email or write to <a href="mailto:${support}">${support}</a>.</p>
<p style="margin:0;">Thank you for reaching out to KIEN Sports.</p>`;
  const text = 'Hi ' + m.name + ",\n\nWe have received your message about: " + m.subject +
    ".\nOur team will get back to you shortly. You can reply to this email or write to " + env.SUPPORT_EMAIL + '.';
  return { subject: 'We received your message - KIEN Sports', html: wrap({ preheader: 'We received your message', bodyHtml: html }), text };
};

// ---- Order lifecycle ----

export interface OrderEmailData {
  orderNumber: string;
  placedAt: Date;
  status: string;
  paymentStatus: string;
  email: string;
  items: { productName: string; colorName: string; size: string | null; quantity: number; unitPricePaise: number; lineTotalPaise: number }[];
  subtotalPaise: number;
  shippingPaise: number;
  taxPaise: number;
  totalPaise: number;
  shippingAddress: { firstName: string; lastName: string; line1: string; line2?: string; city: string; state: string; pincode: string; phone: string } | null;
  shipment?: { carrier: string | null; trackingNumber: string | null } | null;
}

const addressBlock = (a: OrderEmailData['shippingAddress']): string => {
  if (!a) return '';
  const line = [a.line1, a.line2, a.city + ', ' + a.state + ' ' + a.pincode, 'India'].filter(Boolean).join('<br>');
  return '<p style="margin:6px 0 0;">' + escapeHtml(a.firstName + ' ' + a.lastName) + '<br>' + escapeHtml(line) + '</p>';
};

const itemsTable = (items: OrderEmailData['items']): string =>
  items
    .map(
      (i) =>
        '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;">' + escapeHtml(i.productName) +
        (i.size ? ' (' + escapeHtml(i.colorName) + ', ' + escapeHtml(i.size) + ')' : ' (' + escapeHtml(i.colorName) + ')') +
        ' &times; ' + i.quantity + '</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">' +
        escapeHtml(rupees(i.lineTotalPaise)) + '</td></tr>',
    )
    .join('');

const totalsRows = (o: OrderEmailData): string =>
  [
    '<tr><td style="padding:4px 0;color:#777;">Subtotal</td><td style="padding:4px 0;text-align:right;">' + escapeHtml(rupees(o.subtotalPaise)) + '</td></tr>',
    '<tr><td style="padding:4px 0;color:#777;">Shipping</td><td style="padding:4px 0;text-align:right;">' + escapeHtml(rupees(o.shippingPaise)) + '</td></tr>',
    '<tr><td style="padding:10px 0 0;font-weight:700;">Total</td><td style="padding:10px 0 0;text-align:right;font-weight:700;">' + escapeHtml(rupees(o.totalPaise)) + '</td></tr>',
  ].join('');

const plainOrderBody = (o: OrderEmailData): string =>
  [
    'Order: ' + o.orderNumber,
    'Placed: ' + o.placedAt.toLocaleString('en-IN'),
    '', ...o.items.map((i) => i.productName + ' (' + i.colorName + (i.size ? ', ' + i.size : '') + ') x ' + i.quantity + ' - ' + rupees(i.lineTotalPaise)),
    '', 'Subtotal: ' + rupees(o.subtotalPaise), 'Shipping: ' + rupees(o.shippingPaise), 'Total: ' + rupees(o.totalPaise),
    '', 'Questions? Write to ' + env.SUPPORT_EMAIL,
  ].join('\n');

export const orderConfirmationEmail = (o: OrderEmailData): EmailContent => {
  const html = `<p style="margin:0 0 6px;font-weight:700;">Thank you for your order.</p>
<p style="margin:0 0 16px;font-size:12px;color:#777;">Payment verified. Order <strong>${escapeHtml(o.orderNumber)}</strong> is confirmed.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
  <tr><td style="padding:4px 0;color:#777;width:110px;">Order date</td><td>${escapeHtml(o.placedAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }))}</td></tr>
  <tr><td style="padding:4px 0;color:#777;vertical-align:top;">Ship to</td><td>${addressBlock(o.shippingAddress)}</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-top:16px;">${itemsTable(o.items)}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-top:8px;">${totalsRows(o)}</table>
<p style="margin:20px 0 0;font-size:12px;color:#777;">Need help with this order? Write to <a href="mailto:${escapeHtml(env.SUPPORT_EMAIL)}">${escapeHtml(env.SUPPORT_EMAIL)}</a> and mention your order number.</p>`;
  return {
    subject: 'Order confirmed - ' + o.orderNumber + ' - KIEN Sports',
    html: wrap({ preheader: 'Your order ' + o.orderNumber + ' is confirmed', bodyHtml: html }),
    text: plainOrderBody(o),
  };
};

export const businessNewOrderNotification = (o: OrderEmailData): EmailContent => {
  const html = `<p style="margin:0 0 12px;">New order <strong>${escapeHtml(o.orderNumber)}</strong> was placed and payment was verified.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">${itemsTable(o.items)}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-top:8px;">${totalsRows(o)}</table>
<p style="margin:14px 0 0;font-size:12px;color:#777;">Customer email: ${escapeHtml(o.email)} &middot; Status: ${escapeHtml(o.status)} / ${escapeHtml(o.paymentStatus)}</p>`;
  return {
    subject: '[KIEN Order] ' + o.orderNumber + ' confirmed',
    html: wrap({ preheader: 'New order ' + o.orderNumber, bodyHtml: html }),
    text: plainOrderBody(o),
  };
};

export const orderShippedEmail = (o: OrderEmailData): EmailContent => {
  const tracking =
    o.shipment && o.shipment.trackingNumber
      ? '<p style="margin:12px 0 0;">Your order is on its way via <strong>' + escapeHtml(o.shipment.carrier ?? 'our shipping partner') +
        '</strong>. Tracking number: <strong>' + escapeHtml(o.shipment.trackingNumber) + '</strong>.</p>'
      : '<p style="margin:12px 0 0;">Your order is on its way and will reach you shortly.</p>';
  const html = `<p style="margin:0 0 12px;">Good news - order <strong>${escapeHtml(o.orderNumber)}</strong> has shipped.</p>${tracking}
<p style="margin:16px 0 0;font-size:12px;color:#777;">Questions about delivery? Write to <a href="mailto:${escapeHtml(env.SUPPORT_EMAIL)}">${escapeHtml(env.SUPPORT_EMAIL)}</a>.</p>`;
  const text = 'Your order ' + o.orderNumber + ' has shipped.' +
    (o.shipment && o.shipment.trackingNumber ? ' Carrier: ' + (o.shipment.carrier ?? '') + '. Tracking: ' + o.shipment.trackingNumber + '.' : '');
  return {
    subject: 'Your order has shipped - ' + o.orderNumber + ' - KIEN Sports',
    html: wrap({ preheader: 'Order ' + o.orderNumber + ' has shipped', bodyHtml: html }),
    text,
  };
};

export const orderCancelledEmail = (o: OrderEmailData, reason?: string): EmailContent => {
  const html = `<p style="margin:0 0 12px;">Your order <strong>${escapeHtml(o.orderNumber)}</strong> has been cancelled.</p>${reason ? '<p style="margin:0 0 12px;">' + escapeHtml(reason) + '</p>' : ''}
<p style="margin:0;">If you were not expecting this, write to <a href="mailto:${escapeHtml(env.SUPPORT_EMAIL)}">${escapeHtml(env.SUPPORT_EMAIL)}</a>.</p>`;
  return {
    subject: 'Order cancelled - ' + o.orderNumber + ' - KIEN Sports',
    html: wrap({ preheader: 'Order ' + o.orderNumber + ' was cancelled', bodyHtml: html }),
    text: 'Your order ' + o.orderNumber + ' has been cancelled.' + (reason ? ' ' + reason : ''),
  };
};

export const refundCompletedEmail = (o: OrderEmailData, refundRupees: number): EmailContent => {
  const html = `<p style="margin:0 0 12px;">Your return for order <strong>${escapeHtml(o.orderNumber)}</strong> has been completed and a refund of <strong>${escapeHtml(rupees(Math.round(refundRupees * 100)))}</strong> has been initiated to your original payment method.</p>
<p style="margin:0;">Refunds usually take 5-7 business days to appear depending on your bank. If you have questions, write to <a href="mailto:${escapeHtml(env.SUPPORT_EMAIL)}">${escapeHtml(env.SUPPORT_EMAIL)}</a>.</p>`;
  return {
    subject: 'Refund initiated - ' + o.orderNumber + ' - KIEN Sports',
    html: wrap({ preheader: 'Refund for ' + o.orderNumber, bodyHtml: html }),
    text: 'Your return for order ' + o.orderNumber + ' has been completed and a refund of ' + rupees(Math.round(refundRupees * 100)) + ' has been initiated.',
  };
};

// ---- Password reset ----

export const passwordResetEmail = (m: { email: string; resetUrl: string; ttlMinutes: number }): EmailContent => {
  const html = `<p style="margin:0 0 12px;">We received a request to reset the password for your KIEN Sports account.</p>
<p style="margin:0 0 24px;"><a href="${escapeHtml(m.resetUrl)}" style="background:#111;color:#ffffff;padding:14px 28px;text-decoration:none;font-weight:700;display:inline-block;">Reset password</a></p>
<p style="margin:0 0 8px;font-size:12px;color:#777;">This link expires in ${m.ttlMinutes} minutes and can be used only once.</p>
<p style="margin:0;font-size:12px;color:#777;">If you did not request this, you can safely ignore this email - your password will not change.</p>`;
  const text = 'We received a request to reset your KIEN Sports password.\n\nReset link (valid for ' +
    m.ttlMinutes + ' minutes, single use):\n' + m.resetUrl + '\n\nIf you did not request this, ignore this email.';
  return {
    subject: 'Reset your KIEN Sports password',
    html: wrap({ preheader: 'Password reset request', bodyHtml: html }),
    text,
  };
};

// ---- Inbound email (support notification of a received email) ----

export const inboundEmailNotification = (m: { from: string; to: string; subject: string; excerpt: string }): EmailContent => {
  const html = `<p style="margin:0 0 12px;">A new email was received via Resend inbound:</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
  <tr><td style="padding:4px 0;color:#777;width:90px;">From</td><td>${escapeHtml(m.from)}</td></tr>
  <tr><td style="padding:4px 0;color:#777;">To</td><td>${escapeHtml(m.to)}</td></tr>
  <tr><td style="padding:4px 0;color:#777;">Subject</td><td>${escapeHtml(m.subject)}</td></tr>
</table>
<p style="margin:14px 0 0;color:#777;font-size:12px;">The full message is stored in the admin system (InboundEmail record).</p>`;
  const text = 'New inbound email.\nFrom: ' + m.from + '\nTo: ' + m.to + '\nSubject: ' + m.subject;
  return {
    subject: '[KIEN Inbound] ' + m.subject,
    html: wrap({ preheader: 'Inbound email from ' + m.from, bodyHtml: html }),
    text,
  };
};
