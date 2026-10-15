import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { validate } from '../../middleware/validate';
import { apiLimiter } from '../../middleware/errorHandler';
import { env } from '../../config/env';
import { requireAuth, requireRole } from '../../middleware/auth';
import { sendEmailBackground } from '../email/email.service';
import { contactCustomerConfirmation, contactSupportNotification } from '../email/email.templates';

// Matches the frontend ContactPage form exactly:
// name, email, subject (enum), message.
export const CONTACT_SUBJECTS = [
  'order',
  'product',
  'return',
  'partnership',
  'press',
  'other',
] as const;

export const contactRouter = Router();

contactRouter.post(
  '/',
  apiLimiter(60 * 60_000, 5),
  validate({
    body: z.object({
      name: z.string().min(1).max(120),
      email: z.string().email().max(254),
      subject: z.enum(CONTACT_SUBJECTS),
      message: z.string().min(10).max(4000),
    }),
  }),
  async (req, res) => {
    const msg = await prisma.contactMessage.create({ data: req.body });
    // Email notifications are best-effort and never block or fail the
    // request: the message is already safely persisted above.
    // - support notification: Reply-To = the customer's validated address
    // - customer confirmation: sent from the authorized KIEN sender only
    if (env.SUPPORT_EMAIL) {
      void sendEmailBackground({
        to: env.SUPPORT_EMAIL,
        replyTo: msg.email,
        ...contactSupportNotification({
          id: msg.id, name: msg.name, email: msg.email, subject: msg.subject, message: msg.message,
        }),
      });
    }
    void sendEmailBackground({ to: msg.email, ...contactCustomerConfirmation({ name: msg.name, subject: msg.subject }) });
    res.status(201).json({ data: { id: msg.id, message: 'Thanks for reaching out. We will get back to you soon.' } });
  },
);

export const adminContactRouter = Router();
adminContactRouter.use(requireAuth, requireRole('ADMIN'));
adminContactRouter.get('/contact', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'NEW';
  const messages = await prisma.contactMessage.findMany({
    where: { status },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({ data: messages });
});
adminContactRouter.patch(
  '/contact/:id',
  validate({
    params: z.object({ id: z.string().min(10).max(40) }),
    body: z.object({ status: z.enum(['NEW', 'IN_PROGRESS', 'RESOLVED']) }),
  }),
  async (req, res) => {
    const msg = await prisma.contactMessage.update({
      where: { id: String(req.params.id) },
      data: { status: req.body.status },
    });
    res.json({ data: msg });
  },
);
