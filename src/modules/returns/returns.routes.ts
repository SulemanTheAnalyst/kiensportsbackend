import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { notFound } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';

// Returns/refunds foundation. Business rules (return window, conditions) are
// data-driven status fields; admin approves/inspects/completes.

export const returnsRouter = Router();

returnsRouter.post(
  '/',
  requireAuth,
  validate({
    body: z.object({
      orderNumber: z.string().min(6).max(40),
      orderItemId: z.string().min(10).max(40),
      reason: z.string().min(5).max(1000),
    }),
  }),
  async (req, res) => {
    const { orderNumber, orderItemId, reason } = req.body;
    const order = await prisma.order.findUnique({
      where: { orderNumber },
      include: { items: true, returnRequests: true },
    });
    if (!order || order.userId !== req.user!.sub) throw notFound('Order not found');
    if (order.status !== 'DELIVERED') {
      return res.status(400).json({
        error: { code: 'RETURN_NOT_ALLOWED', message: 'Returns can only be requested after delivery', details: null },
      });
    }
    const item = order.items.find((i) => i.id === orderItemId);
    if (!item) throw notFound('Order item not found');
    if (order.returnRequests.some((r) => r.orderItemId === item.id)) {
      return res.status(409).json({
        error: { code: 'RETURN_EXISTS', message: 'A return request already exists for this item', details: null },
      });
    }
    const rr = await prisma.returnRequest.create({
      data: {
        orderId: order.id,
        orderItemId: item.id,
        userId: req.user!.sub,
        reason,
        refundAmountPaise: item.lineTotalPaise,
      },
    });
    res.status(201).json({
      data: { id: rr.id, status: rr.status, refundAmount: rr.refundAmountPaise / 100 },
    });
  },
);

returnsRouter.get('/', requireAuth, async (req, res) => {
  const rrs = await prisma.returnRequest.findMany({
    where: { userId: req.user!.sub },
    include: { order: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    data: rrs.map((r) => ({
      id: r.id,
      orderNumber: r.order.orderNumber,
      status: r.status,
      refundAmount: r.refundAmountPaise / 100,
      createdAt: r.createdAt,
    })),
  });
});

// --- Admin side ---
export const adminReturnsRouter = Router();
adminReturnsRouter.use(requireAuth, requireRole('ADMIN'));

adminReturnsRouter.get('/returns', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const rrs = await prisma.returnRequest.findMany({
    where: status ? { status } : {},
    include: { order: { include: { items: true } }, refunds: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ data: rrs });
});

adminReturnsRouter.patch(
  '/returns/:id',
  validate({
    params: z.object({ id: z.string().min(10).max(40) }),
    body: z.object({
      status: z.enum(['REQUESTED', 'APPROVED', 'RECEIVED', 'INSPECTED', 'REJECTED', 'COMPLETED']),
    }),
  }),
  async (req, res) => {
    const rr = await prisma.returnRequest.findUnique({ where: { id: req.params.id } });
    if (!rr) throw notFound('Return request not found');
    const updated = await prisma.returnRequest.update({
      where: { id: rr.id },
      data: { status: req.body.status },
    });
    // On COMPLETED, create the durable Refund record. The actual provider
    // refund (paymentService.refund) is executed by the admin payments flow.
    if (req.body.status === 'COMPLETED') {
      const order = await prisma.order.findUnique({
        where: { id: rr.orderId },
        include: { payments: true },
      });
      const payment = order?.payments.find((p) => p.providerPaymentId !== null);
      await prisma.refund.upsert({
        where: { id: 'refund_' + rr.id },
        update: {},
        create: {
          id: 'refund_' + rr.id,
          returnRequestId: rr.id,
          provider: payment?.provider ?? 'manual',
          amountPaise: rr.refundAmountPaise,
          status: 'INITIATED',
        },
      });
    }
    res.json({ data: updated });
  },
);
