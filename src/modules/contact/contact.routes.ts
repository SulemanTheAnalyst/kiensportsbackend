import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { validate } from '../../middleware/validate';
import { apiLimiter } from '../../middleware/errorHandler';
import { requireAuth, requireRole } from '../../middleware/auth';

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
