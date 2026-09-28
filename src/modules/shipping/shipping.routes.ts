import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { notFound } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';

// Shipping is stored as data; carrier integration is a future provider
// implementation (Shiprocket/Delhivery/etc.) and plugs into Shipment records.

export const shippingRouter = Router();

// Customer-facing tracking by order number (owner-scoped).
shippingRouter.get(
  '/track/:orderNumber',
  requireAuth,
  validate({ params: z.object({ orderNumber: z.string().min(6).max(40) }) }),
  async (req: Request, res: Response) => {
    const order = await prisma.order.findUnique({
      where: { orderNumber: String(req.params.orderNumber) },
      include: { shipments: true },
    });
    if (!order || order.userId !== req.user!.sub) throw notFound('Shipment not found');
    res.json({
      data: order.shipments.map((s) => ({
        carrier: s.carrier,
        trackingNumber: s.trackingNumber,
        status: s.status,
        shippedAt: s.shippedAt,
        deliveredAt: s.deliveredAt,
      })),
    });
  },
);

export const adminShippingRouter = Router();
adminShippingRouter.use(requireAuth, requireRole('ADMIN'));

adminShippingRouter.patch(
  '/shipments/:id',
  validate({
    params: z.object({ id: z.string().min(10).max(40) }),
    body: z.object({
      carrier: z.string().max(80).optional(),
      trackingNumber: z.string().max(80).optional(),
      status: z.enum(['PENDING', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'EXCEPTION']).optional(),
    }),
  }),
  async (req: Request, res: Response) => {
    const shipment = await prisma.shipment.findUnique({ where: { id: String(req.params.id) }, include: { order: true } });
    if (!shipment) throw notFound('Shipment not found');
    const { carrier, trackingNumber, status } = req.body;
    const updated = await prisma.$transaction(async (tx) => {
      const s = await tx.shipment.update({
        where: { id: shipment.id },
        data: {
          carrier,
          trackingNumber,
          status,
          shippedAt: status && status !== 'PENDING' && !shipment.shippedAt ? new Date() : undefined,
          deliveredAt: status === 'DELIVERED' ? new Date() : undefined,
        },
      });
      if (status === 'DELIVERED') {
        await tx.order.update({ where: { id: shipment.orderId }, data: { status: 'DELIVERED' } });
        await tx.orderStatusEvent.create({
          data: { orderId: shipment.orderId, fromStatus: shipment.order.status, toStatus: 'DELIVERED', actorId: req.user!.sub },
        });
      } else if (status === 'IN_TRANSIT' || status === 'OUT_FOR_DELIVERY') {
        await tx.order.update({ where: { id: shipment.orderId }, data: { status: 'SHIPPED' } });
        await tx.orderStatusEvent.create({
          data: { orderId: shipment.orderId, fromStatus: shipment.order.status, toStatus: 'SHIPPED', actorId: req.user!.sub },
        });
      }
      return s;
    });
    res.json({ data: updated });
  },
);
