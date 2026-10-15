import { OrderStatus, Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { sendOrderEmailOnce } from './email.service';
import { sendEmail, type SendEmailResult } from './email.service';
import {
  businessNewOrderNotification,
  orderCancelledEmail,
  orderConfirmationEmail,
  orderShippedEmail,
  refundCompletedEmail,
  type OrderEmailData,
} from './email.templates';

// Order-lifecycle email orchestration. Every entry point:
// - runs AFTER the relevant transaction committed (never inside it),
// - is best-effort and fire-and-forget (checkout never breaks on email),
// - is idempotent via OrderStatusEvent markers (webhook replays, admin
//   re-saves and races cannot produce duplicate emails).

const orderInclude = {
  items: true,
  shipments: { orderBy: { createdAt: 'desc' as const } },
} satisfies Prisma.OrderInclude;

const toEmailData = (
  order: Prisma.OrderGetPayload<{ include: typeof orderInclude }>,
): OrderEmailData => ({
  orderNumber: order.orderNumber,
  placedAt: order.placedAt ?? order.createdAt,
  status: order.status,
  paymentStatus: order.paymentStatus,
  email: order.email,
  items: order.items.map((i) => ({
    productName: i.productName,
    colorName: i.colorName,
    size: i.size,
    quantity: i.quantity,
    unitPricePaise: i.unitPricePaise,
    lineTotalPaise: i.lineTotalPaise,
  })),
  subtotalPaise: order.subtotalPaise,
  shippingPaise: order.shippingPaise,
  taxPaise: order.taxPaise,
  totalPaise: order.totalPaise,
  shippingAddress: (order.shippingAddress as OrderEmailData['shippingAddress']) ?? null,
  shipment: order.shipments[0]
    ? { carrier: order.shipments[0].carrier, trackingNumber: order.shipments[0].trackingNumber }
    : null,
});

const withOrder = async (
  orderNumber: string,
  send: (data: OrderEmailData) => Promise<SendEmailResult>,
) => {
  const order = await prisma.order.findUnique({ where: { orderNumber }, include: orderInclude });
  if (!order) {
    logger.warn({ orderNumber }, 'Order email skipped: order not found');
    return;
  }
  await send(toEmailData(order));
};

// Customer order confirmation + business notification. Callers must only
// invoke this once payment is verified (Razorpay webhook) or the order is
// operationally confirmed (COD via admin transition).
export const notifyOrderConfirmed = (orderNumber: string) => {
  void (async () => {
    const order = await prisma.order.findUnique({ where: { orderNumber }, include: orderInclude });
    if (!order || order.paymentStatus === 'PENDING' || order.status === OrderStatus.PENDING_PAYMENT) {
      // Never claim a paid/confirmed order before it actually is.
      return;
    }
    await sendOrderEmailOnce('ORDER_CONFIRMED', order.id, undefined, () => {
      return withOrderInner(order!, orderConfirmationEmail);
    });
    // Business notification (if configured) with its own marker. Sent to
    // the business address, never to the customer.
    if (env.BUSINESS_NOTIFICATION_EMAIL) {
      await sendOrderEmailOnce('BUSINESS_ORDER_CONFIRMED', order.id, undefined, () => {
        const data = toEmailData(order!);
        return sendEmail({ to: env.BUSINESS_NOTIFICATION_EMAIL, ...businessNewOrderNotification(data) });
      });
    }
  })().catch(() => undefined);
};

// Internal helper: build + send one template for an already-loaded order.
const withOrderInner = async (
  order: Prisma.OrderGetPayload<{ include: typeof orderInclude }>,
  template: (o: OrderEmailData) => { subject: string; html: string; text: string },
): Promise<SendEmailResult> => {
  const data = toEmailData(order);
  const content = template(data);
  return sendEmail({ to: data.email, ...content });
};

export const notifyOrderShipped = (orderNumber: string) => {
  void (async () => {
    const order = await prisma.order.findUnique({ where: { orderNumber }, include: orderInclude });
    if (!order || order.status !== OrderStatus.SHIPPED) return;
    await sendOrderEmailOnce('ORDER_SHIPPED', order.id, undefined, () =>
      withOrderInner(order, orderShippedEmail),
    );
  })().catch(() => undefined);
};

export const notifyOrderCancelled = (orderNumber: string) => {
  void (async () => {
    const order = await prisma.order.findUnique({ where: { orderNumber }, include: orderInclude });
    if (!order || order.status !== OrderStatus.CANCELLED) return;
    await sendOrderEmailOnce('ORDER_CANCELLED', order.id, undefined, () =>
      withOrderInner(order, (o) => orderCancelledEmail(o)),
    );
  })().catch(() => undefined);
};

export const notifyRefundCompleted = (returnRequestId: string) => {
  void (async () => {
    const rr = await prisma.returnRequest.findUnique({
      where: { id: returnRequestId },
      include: { order: { include: orderInclude } },
    });
    if (!rr) return;
    await sendOrderEmailOnce('REFUND_COMPLETED', rr.orderId, rr.id, () =>
      withOrderInner(rr.order, (o) => refundCompletedEmail(o, rr.refundAmountPaise / 100)),
    );
  })().catch(() => undefined);
};

export const __internal = { withOrder, toEmailData };
