import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { ApiError, badRequest } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { verifySvixSignature } from './svix';
import { Resend } from 'resend';
import { sendEmailBackground } from './email.service';
import { inboundEmailNotification } from './email.templates';

// Resend inbound email webhook.
//
// Flow: Resend (inbound domain) -> this endpoint -> Svix signature
// verification -> payload validation -> store metadata + body -> optional
// support notification. The webhook payload contains METADATA ONLY; the
// body is fetched from the Resend Receiving API in the background.
//
// Registered URL in the Resend dashboard:
//   https://api.kiensports.com/api/v1/webhooks/resend/inbound
//   (local dev: https://<tunnel>/api/v1/webhooks/resend/inbound)
// Signing secret (whsec_..., shown once on webhook creation) -> RESEND_WEBHOOK_SECRET.

export const resendInboundRouter = Router();

const attachmentSchema = z.object({
  id: z.string().optional(),
  filename: z.string().optional(),
  content_type: z.string().optional(),
});

const inboundEventSchema = z.object({
  type: z.string().min(1),
  created_at: z.string().optional(),
  data: z
    .object({
      email_id: z.string().min(1),
      from: z.string().min(1),
      to: z.array(z.string()).min(1),
      cc: z.array(z.string()).optional().default([]),
      bcc: z.array(z.string()).optional().default([]),
      subject: z.string().max(998).default(''),
      attachments: z.array(attachmentSchema).optional().default([]),
    })
    .passthrough(),
});

// Body/attachment content is deliberately NOT stored wholesale: only a
// truncated plain-text excerpt plus attachment FILENAME metadata.
const MAX_BODY_EXCERPT_CHARS = 20_000;

const fetchBody = async (emailId: string): Promise<{ text: string | null; html: string | null }> => {
  if (!env.RESEND_API_KEY) return { text: null, html: null };
  try {
    const resend = new Resend(env.RESEND_API_KEY);
    const { data, error } = await resend.emails.receiving.get(emailId);
    if (error || !data) {
      logger.warn({ emailId }, 'Receiving API returned no content for inbound email');
      return { text: null, html: null };
    }
    const rec = data as unknown as { text?: string | null; html?: string | null };
    return { text: rec.text ?? null, html: rec.html ?? null };
  } catch (err) {
    logger.error(
      { message: err instanceof Error ? err.message : 'unknown' },
      'Receiving API request failed',
    );
    return { text: null, html: null };
  }
};

resendInboundRouter.post('/inbound', async (req, res) => {
  if (!env.RESEND_WEBHOOK_SECRET) {
    // Fail closed, 503 so Svix/Resend retries once configured.
    throw new ApiError(503, 'WEBHOOK_NOT_CONFIGURED', 'Inbound email webhook is not configured');
  }
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!rawBody) throw badRequest('Missing raw body for verification');
  const headers = {
    id: (req.headers['svix-id'] as string) || '',
    timestamp: (req.headers['svix-timestamp'] as string) || '',
    signature: (req.headers['svix-signature'] as string) || '',
  };
  const payload = rawBody.toString('utf8');
  if (!verifySvixSignature({ secret: env.RESEND_WEBHOOK_SECRET, payload, headers })) {
    logger.warn({ path: req.path }, 'Resend webhook rejected: invalid signature');
    throw badRequest('Invalid webhook signature');
  }

  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    throw badRequest('Malformed webhook payload');
  }
  const parsed = inboundEventSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn({ path: req.path }, 'Resend webhook rejected: malformed event payload');
    throw badRequest('Malformed webhook payload');
  }
  const event = parsed.data;

  // Only inbound email events are processed; anything else is acknowledged
  // and ignored so Resend does not retry forever.
  if (event.type !== 'email.received') {
    logger.info({ type: event.type }, 'Acknowledged and ignored non-inbound Resend event');
    res.json({ data: { ok: true, ignored: true } });
    return;
  }

  const { email_id: emailId, from, to, cc, subject, attachments } = event.data;

  // Duplicate deliveries (Svix replays) are acknowledged without reprocessing.
  const existing = await prisma.inboundEmail.findUnique({ where: { emailId } });
  if (existing) {
    logger.info({ emailId }, 'Duplicate inbound webhook delivery acknowledged');
    res.json({ data: { ok: true, duplicate: true } });
    return;
  }

  // Store metadata only (no attachment payloads). Truncate aggressively.
  const stored = await prisma.inboundEmail.create({
    data: {
      emailId,
      from: from.slice(0, 254),
      to: to.join(', ').slice(0, 500),
      cc: cc.length ? cc.join(', ').slice(0, 500) : null,
      subject: subject.slice(0, 998),
      attachments: attachments.length
        ? (attachments.map((a) => ({ filename: a.filename ?? null, content_type: a.content_type ?? null })) as unknown as object[])
        : undefined,
    },
  });
  logger.info({ emailId, inboundId: stored.id }, 'Inbound email received');

  // Acknowledge immediately; content fetch and notification run in the
  // background. Failures there never affect the acknowledgement.
  res.json({ data: { ok: true } });

  if (env.RESEND_API_KEY) {
    void (async () => {
      const body = await fetchBody(emailId);
      await prisma.inboundEmail
        .update({
          where: { id: stored.id },
          data: {
            status: body.text || body.html ? 'FETCHED' : 'FETCH_FAILED',
            bodyText: body.text ? body.text.slice(0, MAX_BODY_EXCERPT_CHARS) : null,
            bodyHtml: body.html ? body.html.slice(0, MAX_BODY_EXCERPT_CHARS) : null,
          },
        })
        .catch((err: unknown) =>
          logger.error({ message: err instanceof Error ? err.message : 'unknown' }, 'Inbound email body save failed'),
        );
    })();
  } else {
    await prisma.inboundEmail
      .update({ where: { id: stored.id }, data: { status: 'FETCH_FAILED' } })
      .catch(() => undefined);
  }

  if (env.SUPPORT_EMAIL && env.RESEND_API_KEY) {
    const notif = inboundEmailNotification({
      from: stored.from,
      to: stored.to,
      subject: stored.subject,
      excerpt: '',
    });
    void sendEmailBackground({ to: env.SUPPORT_EMAIL, ...notif });
  }
});
