import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { validate } from '../../middleware/validate';
import { apiLimiter } from '../../middleware/errorHandler';
import { randomToken } from '../../lib/ids';
import { env } from '../../config/env';
import { badRequest } from '../../lib/errors';
import { requireAuth, requireRole } from '../../middleware/auth';

export const newsletterRouter = Router();

newsletterRouter.post(
  '/subscribe',
  apiLimiter(60 * 60_000, 10),
  validate({ body: z.object({ email: z.string().email().max(254) }) }),
  async (req, res) => {
    const email = req.body.email.toLowerCase();
    const existing = await prisma.newsletterSubscriber.findUnique({ where: { email } });
    if (existing && existing.status === 'CONFIRMED') {
      return res.json({ data: { ok: true, message: 'You are already subscribed.' } });
    }
    const token = randomToken(24);
    await prisma.newsletterSubscriber.upsert({
      where: { email },
      update: { status: 'PENDING', token },
      create: { email, status: 'PENDING', token },
    });
    // Email sending is a later phase; the confirm URL is the contract.
    const confirmUrl = env.FRONTEND_URL + '/newsletter/confirm?token=' + token;
    res.json({
      data: {
        ok: true,
        message: 'Subscription created. Please confirm via the link sent to your email.',
        ...(env.NODE_ENV !== 'production' ? { devConfirmUrl: confirmUrl } : {}),
      },
    });
  },
);

newsletterRouter.post(
  '/confirm',
  apiLimiter(60 * 60_000, 20),
  validate({ body: z.object({ token: z.string().min(20).max(128) }) }),
  async (req, res) => {
    const sub = await prisma.newsletterSubscriber.findUnique({ where: { token: req.body.token } });
    if (!sub) throw badRequest('Invalid confirmation token');
    await prisma.newsletterSubscriber.update({
      where: { id: sub.id },
      data: { status: 'CONFIRMED', token: randomToken(24) }, // rotate token after use
    });
    res.json({ data: { ok: true } });
  },
);

newsletterRouter.post(
  '/unsubscribe',
  apiLimiter(60 * 60_000, 20),
  validate({ body: z.object({ email: z.string().email().max(254) }) }),
  async (req, res) => {
    await prisma.newsletterSubscriber.updateMany({
      where: { email: req.body.email.toLowerCase() },
      data: { status: 'UNSUBSCRIBED' },
    });
    res.json({ data: { ok: true } });
  },
);

// Admin export
export const adminNewsletterRouter = Router();
adminNewsletterRouter.use(requireAuth, requireRole('ADMIN'));
adminNewsletterRouter.get('/newsletter/subscribers', async (_req, res) => {
  const subs = await prisma.newsletterSubscriber.findMany({
    where: { status: 'CONFIRMED' },
    select: { email: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ data: subs });
});
