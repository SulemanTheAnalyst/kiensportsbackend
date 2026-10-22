import { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { sendEmail } from '../email/email.service';
import { escapeHtml } from '../email/email.templates';

// Durable business-notification outbox.
//
// Design (the smallest reliable solution for a single Render web service -
// no external queue required):
//  - Every business event is recorded as a NotificationOutbox row with a
//    UNIQUE dedupeKey. Replays (duplicate webhooks, checkout retries,
//    repeated cart adds inside the cooldown window) hit the unique
//    constraint and are suppressed.
//  - Recording is awaited by callers (one small INSERT) but DELIVERY is
//    fire-and-forget: a provider outage can never block or roll back
//    checkout, payments or order state.
//  - A flush pass sends PENDING rows (max 5 attempts) and stores the
//    outcome. When no channel is configured the row stays PENDING and is
//    delivered once the env vars are set; provider failures are retried on
//    later flushes.
//  - Logs carry only the event type and outcome - never API secrets or
//    customer PII. Payloads live in the database, not in logs.

export type BusinessEventType =
  | 'ORDER_CREATED'
  | 'PAYMENT_SUCCEEDED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_EXPIRED'
  | 'PAYMENT_LATE'
  | 'COD_COLLECTED'
  | 'CART_ACTIVITY';

export interface BusinessEventPayload {
  orderNumber?: string | null;
  createdAt?: string | null;
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  totalRupees?: number | null;
  currency?: string | null;
  items?: string[];
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  city?: string | null;
  state?: string | null;
  adminLink?: string | null;
  reason?: string | null;
  cartOrSessionId?: string | null;
  productName?: string | null;
  variant?: string | null;
  quantity?: number | null;
  [key: string]: unknown;
}

// Build the notification payload from an order row. Loose shape on purpose:
// callers pass Prisma payloads with different includes.
export const orderNotificationPayload = (
  order: {
    orderNumber: string;
    email: string;
    paymentStatus: string;
    totalPaise: number;
    createdAt: Date;
    shippingAddress: unknown;
    items?: { productName: string; quantity: number; size?: string | null; colorName?: string | null }[];
    payments?: { method: string }[];
  },
  extra: BusinessEventPayload = {},
): BusinessEventPayload => {
  const addr = (order.shippingAddress as Record<string, unknown>) ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    orderNumber: order.orderNumber,
    createdAt: order.createdAt.toISOString(),
    paymentMethod: order.payments?.map((p) => p.method).join(', ') || null,
    paymentStatus: order.paymentStatus,
    totalRupees: order.totalPaise / 100,
    currency: 'INR',
    items:
      order.items?.map(
        (i) =>
          i.productName +
          ' x' +
          i.quantity +
          (i.size ? ' (' + i.size + ')' : '') +
          (i.colorName ? ' - ' + i.colorName : ''),
      ) ?? [],
    customerName: [str(addr.firstName), str(addr.lastName)].filter(Boolean).join(' ') || null,
    customerPhone: str(addr.phone),
    customerEmail: order.email,
    city: str(addr.city),
    state: str(addr.state),
    adminLink: env.ADMIN_ORDER_URL_BASE
      ? env.ADMIN_ORDER_URL_BASE.replace(/\/+$/, '') + '/' + order.orderNumber
      : null,
    ...extra,
  };
};

// Record a business event exactly once. Returns true when newly recorded.
export const recordBusinessEvent = async (
  type: BusinessEventType,
  dedupeKey: string,
  payload: BusinessEventPayload,
): Promise<boolean> => {
  try {
    await prisma.notificationOutbox.create({
      data: { type, dedupeKey, payload: payload as unknown as Prisma.InputJsonValue },
    });
    void flushOutbox().catch(() => undefined);
    return true;
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'P2002') return false; // duplicate event
    logger.error(
      { type, message: (err as Error)?.message ?? 'unknown' },
      'Failed to record business notification (business state unaffected)',
    );
    return false;
  }
};

const TITLES: Record<BusinessEventType, string> = {
  ORDER_CREATED: 'New order',
  PAYMENT_SUCCEEDED: 'Payment captured',
  PAYMENT_FAILED: 'Payment FAILED',
  PAYMENT_EXPIRED: 'Payment attempt EXPIRED',
  PAYMENT_LATE: 'LATE payment after expiry - action needed',
  COD_COLLECTED: 'COD payment collected',
  CART_ACTIVITY: 'Cart activity (not an order)',
};

const buildContent = (type: BusinessEventType, p: BusinessEventPayload) => {
  const title = TITLES[type];
  const subject = '[KIEN Ops] ' + title + (p.orderNumber ? ' - ' + p.orderNumber : '');
  const lines: string[] = ['Event: ' + title];
  const add = (label: string, v: unknown) => {
    if (v !== null && v !== undefined && v !== '') lines.push(label + ': ' + String(v));
  };
  add('Order number', p.orderNumber);
  add('Time', p.createdAt);
  add('Payment method', p.paymentMethod);
  add('Payment status', p.paymentStatus);
  if (p.totalRupees !== null && p.totalRupees !== undefined) {
    lines.push('Total: ₹' + p.totalRupees + ' ' + (p.currency ?? 'INR'));
  }
  if (Array.isArray(p.items) && p.items.length > 0) lines.push('Items: ' + p.items.join('; '));
  add('Customer name', p.customerName);
  add('Customer phone', p.customerPhone);
  add('Customer email', p.customerEmail);
  add('Delivery city/state', [p.city, p.state].filter(Boolean).join(', ') || null);
  if (type === 'CART_ACTIVITY') {
    add('Product', p.productName);
    add('Variant', p.variant);
    add('Quantity', p.quantity);
    add('Cart/session', p.cartOrSessionId);
    lines.push('Note: this is a cart addition, NOT an order or a purchase.');
  } else if (!p.customerName && !p.customerEmail && !p.customerPhone) {
    lines.push('Customer: no contact details supplied');
  }
  add('Reason', p.reason);
  add('Admin link', p.adminLink);
  const text = lines.join('\n');
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;">' +
    lines.map((l) => '<p style="margin:0 0 6px;">' + escapeHtml(l) + '</p>').join('') +
    '</div>';
  return { subject, html, text };
};

// Optional WhatsApp Business Platform channel (Meta Cloud API). OFF unless
// explicitly configured; requires a Meta Business account, a registered
// phone number and approved templates. Meta charges per-conversation
// pricing. Until a real test message succeeds, treat the channel as off.
const whatsappEnabled = () =>
  env.WHATSAPP_ENABLED === 'true' &&
  Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_RECIPIENT);

const sendWhatsAppText = async (text: string): Promise<boolean> => {
  try {
    const res = await fetch('https://graph.facebook.com/v20.0/' + env.WHATSAPP_PHONE_NUMBER_ID + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: env.WHATSAPP_RECIPIENT,
        type: 'text',
        text: { body: text.slice(0, 4000) },
      }),
    });
    if (!res.ok) {
      logger.error({ status: res.status }, 'WhatsApp send failed (notification delivery only)');
      return false;
    }
    return true;
  } catch {
    return false;
  }
};

let flushing = false;

// Deliver PENDING outbox rows. Never throws. Rows without a configured
// channel stay PENDING; provider failures are retried on later flushes
// (attempts cap at 5). A SENT row is never re-sent, so retries cannot
// duplicate successful messages.
export const flushOutbox = async (): Promise<void> => {
  if (flushing) return;
  flushing = true;
  try {
    const rows = await prisma.notificationOutbox.findMany({
      where: { status: 'PENDING', attempts: { lt: 5 } },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    for (const row of rows) {
      try {
        const content = buildContent(row.type as BusinessEventType, (row.payload ?? {}) as BusinessEventPayload);
        const emailConfigured = Boolean(env.BUSINESS_NOTIFICATION_EMAIL && env.RESEND_API_KEY);
        let emailAccepted = false;
        let error: string | null = emailConfigured ? null : 'EMAIL_NOT_CONFIGURED';
        if (emailConfigured) {
          const result = await sendEmail({ to: env.BUSINESS_NOTIFICATION_EMAIL as string, ...content });
          emailAccepted = result.accepted;
          if (!emailAccepted) error = result.error ?? 'EMAIL_REJECTED';
        }
        const waAccepted = whatsappEnabled() ? await sendWhatsAppText(content.text) : false;
        const delivered = emailAccepted || waAccepted;
        if (!delivered && !emailConfigured && !whatsappEnabled()) error = 'NO_CHANNEL_CONFIGURED';
        if (delivered) {
          await prisma.notificationOutbox.update({
            where: { id: row.id },
            data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 }, lastError: null },
          });
        } else {
          // stays PENDING; retried by a later flush (attempts capped)
          await prisma.notificationOutbox.update({
            where: { id: row.id },
            data: { attempts: { increment: 1 }, lastError: error },
          });
        }
      } catch (err) {
        await prisma.notificationOutbox
          .update({
            where: { id: row.id },
            data: {
              attempts: { increment: 1 },
              lastError: (err instanceof Error ? err.message : 'unknown').slice(0, 200),
            },
          })
          .catch(() => undefined);
      }
    }
  } finally {
    flushing = false;
  }
};

// Cart-add business notification. Cooldown: at most one notification per
// cart+variant per 30-minute window. Guests carry only their cart/session
// id and the product details - no invented identity, no fingerprinting.
// Authenticated users carry the contact details legitimately associated
// with their account.
export const notifyCartAdd = async (input: {
  cartId: string;
  variantId: string;
  quantity: number;
  userId: string | null;
}): Promise<void> => {
  try {
    const variant = await prisma.productVariant.findUnique({
      where: { id: input.variantId },
      include: { product: { select: { name: true } } },
    });
    if (!variant) return;
    const bucket = Math.floor(Date.now() / (30 * 60_000));
    const dedupeKey = 'CART_ACTIVITY:' + input.cartId + ':' + input.variantId + ':' + bucket;
    const payload: BusinessEventPayload = {
      cartOrSessionId: input.cartId,
      productName: variant.product.name,
      variant: [variant.colorName, variant.size].filter(Boolean).join(' / ') || null,
      quantity: input.quantity,
      createdAt: new Date().toISOString(),
      customerName: null,
      customerPhone: null,
      customerEmail: null,
    };
    if (input.userId) {
      const user = await prisma.user.findUnique({ where: { id: input.userId } });
      if (user) {
        payload.customerName = [user.firstName, user.lastName].filter(Boolean).join(' ') || null;
        payload.customerPhone = user.phone ?? null;
        payload.customerEmail = user.email;
      }
    }
    await recordBusinessEvent('CART_ACTIVITY', dedupeKey, payload);
  } catch (err) {
    logger.warn(
      { message: err instanceof Error ? err.message : 'unknown' },
      'Cart activity notification skipped (cart state is unaffected)',
    );
  }
};
