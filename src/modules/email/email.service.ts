import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { Resend } from 'resend';

// Reusable transactional email service (Resend SDK).
//
// Semantics: Resend's send API returns ACCEPTANCE, not delivery proof.
// A 2xx response means Resend accepted the message for delivery; actual
// delivery confirmation arrives separately via Resend delivery webhooks
// (not configured in this phase). Nothing here claims delivery.
//
// Never throws: callers use sendEmail()/sendEmailBackground() without
// try/catch so a provider outage can never break checkout, auth or admin
// flows. Failures are logged (structured, no content, no secrets) and can
// be safely retried by re-invoking - sends have no side effects on orders
// or payments.

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Explicit Reply-To (e.g. the customer's validated address on contact
   * notifications). Falls back to EMAIL_REPLY_TO. */
  replyTo?: string;
  bcc?: string;
}

export interface SendEmailResult {
  accepted: boolean;
  providerId?: string;
  error?: string;
}

let client: Resend | null = null;
const getClient = (): Resend | null => {
  if (!env.RESEND_API_KEY) return null;
  if (!client) client = new Resend(env.RESEND_API_KEY);
  return client;
};

// Local part masked; never log full addresses or content.
const maskedRecipient = (to: string) => {
  const at = to.indexOf('@');
  return at > 1 ? to.slice(0, 2) + '***@' + to.slice(at + 1) : '***';
};

export const sendEmail = async (input: SendEmailInput): Promise<SendEmailResult> => {
  const c = getClient();
  if (!c) {
    logger.warn({ to: maskedRecipient(input.to) }, 'Email skipped: RESEND_API_KEY not configured');
    return { accepted: false, error: 'NOT_CONFIGURED' };
  }
  const replyTo = input.replyTo ?? (env.EMAIL_REPLY_TO || undefined);
  try {
    const { data, error } = await c.emails.send({
      from: env.EMAIL_FROM,
      to: [input.to],
      bcc: input.bcc ? [input.bcc] : undefined,
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(replyTo ? { replyTo } : {}),
    });
    if (error) {
      logger.error(
        { providerError: error.name, to: maskedRecipient(input.to) },
        'Resend rejected email',
      );
      return { accepted: false, error: error.name };
    }
    logger.info(
      { providerId: data?.id, to: maskedRecipient(input.to), subject: input.subject.slice(0, 80) },
      'Email accepted by provider (delivery not yet confirmed)',
    );
    return { accepted: true, providerId: data?.id };
  } catch (err) {
    logger.error(
      { message: err instanceof Error ? err.message : 'unknown', to: maskedRecipient(input.to) },
      'Email provider request failed',
    );
    return { accepted: false, error: 'PROVIDER_FAILURE' };
  }
};

// Fire-and-forget variant for transactional notifications that must never
// block (and never fail) the primary operation.
export const sendEmailBackground = (input: SendEmailInput): Promise<SendEmailResult> => {
  return sendEmail(input).then((result) => {
    if (!result.accepted) {
      logger.warn({ error: result.error }, 'Background email was not sent');
    }
    return result;
  });
};

// ---- Idempotent order-lifecycle notifications ----
// Retries (webhook replays, admin re-saves) must not produce duplicate
// emails. A marker row in OrderStatusEvent records that a given
// notification kind was already accepted by the provider.

export type OrderEmailKind =
  | 'ORDER_CONFIRMED'
  | 'BUSINESS_ORDER_CONFIRMED'
  | 'ORDER_SHIPPED'
  | 'ORDER_CANCELLED'
  | 'ORDER_RETURNED'
  | 'REFUND_COMPLETED';

export const orderEmailAlreadySent = async (dedupeKey: string, orderId: string) => {
  const marker = 'EMAIL_SENT:' + dedupeKey;
  return prisma.orderStatusEvent.findFirst({ where: { orderId, note: { startsWith: marker } } });
};

export const sendOrderEmailOnce = async (
  kind: OrderEmailKind,
  orderId: string,
  dedupeKey: string | undefined,
  send: () => Promise<SendEmailResult>,
): Promise<{ skipped: boolean; accepted: boolean }> => {
  const key = kind + (dedupeKey ? ':' + dedupeKey : '');
  const marker = 'EMAIL_SENT:' + key;
  try {
    const existing = await orderEmailAlreadySent(key, orderId);
    if (existing) return { skipped: true, accepted: false };
    const result = await send();
    if (result.accepted) {
      await prisma.orderStatusEvent.create({
        data: {
          orderId,
          fromStatus: 'NONE',
          toStatus: 'NONE',
          note: marker + ':' + (result.providerId ?? ''),
        },
      });
    }
    return { skipped: false, accepted: result.accepted };
  } catch (err) {
    logger.error(
      { message: err instanceof Error ? err.message : 'unknown', kind },
      'Order email notification failed (order state is unaffected)',
    );
    return { skipped: false, accepted: false };
  }
};
