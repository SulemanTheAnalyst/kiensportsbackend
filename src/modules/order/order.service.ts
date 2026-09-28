import { OrderStatus, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { notFound, forbidden, ApiError } from '../../lib/errors';
import { computeTotals, paiseToRupees } from '../../lib/money';
import { generateOrderNumber } from '../../lib/ids';
import { getOrCreateCart } from '../cart/cart.session';
import { validateCartForCheckout } from '../cart/cart.service';
import type { Request } from 'express';
import { paymentService } from '../payment/payment.service';

const orderInclude = {
  items: true,
  payments: true,
  shipments: true,
  statusEvents: { orderBy: { createdAt: 'asc' as const } },
} satisfies Prisma.OrderInclude;

export interface AddressInput {
  firstName: string;
  lastName: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
}

// Transactional order creation:
// 1. lock inventory rows FOR UPDATE
// 2. re-resolve prices server-side, validate stock
// 3. reserve inventory, create immutable order + items + payment record
// 4. create the provider payment session
export const createOrder = async (
  req: Request,
  input: { email: string; address: AddressInput; method: PaymentMethod },
) => {
  const cart = await getOrCreateCart(req);
  if (cart.items.length === 0) throw new ApiError(400, 'CART_EMPTY', 'Your bag is empty');

  await validateCartForCheckout(cart);

  const email = input.email.toLowerCase();
  const order = await prisma.$transaction(async (tx) => {
    // Lock inventory rows to prevent overselling under concurrency.
    const variantIds = cart.items.map((i) => i.variantId);
    const locked = await tx.$queryRaw<{ variantId: string; availableQty: number; reservedQty: number }[]>`
      SELECT "variantId", "availableQty", "reservedQty" FROM "Inventory"
      WHERE "variantId" IN (${Prisma.join(variantIds)})
      FOR UPDATE
    `;
    const invMap = new Map(locked.map((r) => [r.variantId, r]));

    for (const item of cart.items) {
      const inv = invMap.get(item.variantId);
      if (!inv || inv.availableQty < item.quantity) {
        throw new ApiError(409, 'OUT_OF_STOCK', 'Stock changed while checking out', {
          sku: item.variant.sku,
        });
      }
    }

    const lines = cart.items.map((item) => {
      const unitPricePaise = item.variant.pricePaise ?? item.variant.product.pricePaise;
      return {
        variantId: item.variantId,
        productName: item.variant.product.name,
        productSlug: item.variant.product.slug,
        sku: item.variant.sku,
        colorName: item.variant.colorName,
        size: item.variant.size,
        quantity: item.quantity,
        unitPricePaise,
        lineTotalPaise: unitPricePaise * item.quantity,
      };
    });
    const totals = computeTotals(lines.map((l) => ({ unitPricePaise: l.unitPricePaise, quantity: l.quantity })));

    const created = await tx.order.create({
      data: {
        orderNumber: generateOrderNumber(),
        userId: req.user?.sub ?? null,
        email,
        subtotalPaise: totals.subtotalPaise,
        shippingPaise: totals.shippingPaise,
        taxPaise: totals.taxPaise,
        totalPaise: totals.totalPaise,
        shippingAddress: input.address as unknown as Prisma.InputJsonValue,
        items: { create: lines.map(({ variantId, ...rest }) => ({ ...rest, variant: { connect: { id: variantId } } })) },
        statusEvents: { create: { fromStatus: 'NONE', toStatus: 'PENDING_PAYMENT', note: 'Order created' } },
      },
      include: orderInclude,
    });

    // Reserve inventory + movement history.
    for (const item of cart.items) {
      await tx.inventory.update({
        where: { variantId: item.variantId },
        data: {
          availableQty: { decrement: item.quantity },
          reservedQty: { increment: item.quantity },
        },
      });
      await tx.inventoryMovement.create({
        data: {
          variantId: item.variantId,
          deltaQty: -item.quantity,
          type: 'RESERVE',
          reference: created.orderNumber,
        },
      });
      // Keep cart line prices in sync with what was actually charged.
      await tx.cartItem.update({
        where: { id: item.id },
        data: { unitPricePaise: item.variant.pricePaise ?? item.variant.product.pricePaise },
      });
    }

    await tx.payment.create({
      data: {
        orderId: created.id,
        provider: paymentService.providerName(),
        method: input.method,
        amountPaise: totals.totalPaise,
      },
    });

    // Mark cart converted; checkout complete.
    await tx.cart.update({ where: { id: cart.id }, data: { status: 'CONVERTED' } });

    return created;
  }, { timeout: 15000 });

  // Provider session creation happens outside the DB transaction.
  const payment = await paymentService.createPaymentSession(order);
  return { order, payment };
};

export interface AddressInput {
  firstName: string;
  lastName: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
}

export const serializeOrder = (order: Prisma.OrderGetPayload<{ include: typeof orderInclude }>, withEvents = false) => {
  const base = {
    id: order.id,
    orderNumber: order.orderNumber,
    email: order.email,
    status: order.status,
    paymentStatus: order.paymentStatus,
    subtotal: paiseToRupees(order.subtotalPaise),
    shipping: paiseToRupees(order.shippingPaise),
    tax: paiseToRupees(order.taxPaise),
    total: paiseToRupees(order.totalPaise),
    shippingAddress: order.shippingAddress,
    placedAt: order.placedAt,
    createdAt: order.createdAt,
    items: order.items.map((i) => ({
      name: i.productName,
      slug: i.productSlug,
      sku: i.sku,
      color: i.colorName,
      size: i.size,
      quantity: i.quantity,
      price: paiseToRupees(i.unitPricePaise),
      lineTotal: paiseToRupees(i.lineTotalPaise),
    })),
    payments: order.payments.map((p) => ({
      method: p.method,
      status: p.status,
      provider: p.provider,
    })),
    shipment: order.shipments[0]
      ? {
          carrier: order.shipments[0].carrier,
          trackingNumber: order.shipments[0].trackingNumber,
          status: order.shipments[0].status,
          shippedAt: order.shipments[0].shippedAt,
          deliveredAt: order.shipments[0].deliveredAt,
        }
      : null,
  };
  if (!withEvents) return base;
  return {
    ...base,
    events: order.statusEvents.map((e) => ({ status: e.toStatus, note: e.note, at: e.createdAt })),
  };
};

export const getOrderForCustomer = async (userId: string | null, orderNumber: string, withEvents = false) => {
  const order = await prisma.order.findUnique({
    where: { orderNumber },
    include: orderInclude,
  });
  if (!order) throw notFound('Order not found');
  if (order.userId && userId && order.userId !== userId) {
    throw forbidden(); // IDOR guard
  }
  if (order.userId && userId !== order.userId) {
    throw notFound('Order not found'); // do not reveal existence
  }
  return serializeOrder(order, withEvents);
};

export const listCustomerOrders = async (userId: string) => {
  const orders = await prisma.order.findMany({
    where: { userId },
    include: orderInclude,
    orderBy: { createdAt: 'desc' },
  });
  return orders.map((o) => serializeOrder(o));
};

// Internal: confirm an order after a verified webhook (see payment module).
export const confirmOrderPayment = async (providerPaymentId: string) => {
  const payment = await prisma.payment.findFirst({
    where: { providerPaymentId },
    include: { order: { include: { items: true } } },
  });
  if (!payment) throw notFound('Payment not found for ' + providerPaymentId);
  if (payment.status === 'CAPTURED' && payment.webhookVerifiedAt) {
    return payment.order; // idempotent replay
  }
  return prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: 'CAPTURED', webhookVerifiedAt: new Date(), providerPaymentId },
    });
    const order = await tx.order.update({
      where: { id: payment.orderId },
      data: {
        paymentStatus: PaymentStatus.PAID,
        status: OrderStatus.CONFIRMED,
        placedAt: new Date(),
      },
      include: orderInclude,
    });
    await tx.orderStatusEvent.create({
      data: { orderId: order.id, fromStatus: 'PENDING_PAYMENT', toStatus: 'CONFIRMED', note: 'Payment verified via webhook' },
    });
    // Convert reservations into sales.
    for (const item of order.items) {
      if (!item.variantId) continue;
      await tx.inventory.update({
        where: { variantId: item.variantId },
        data: { reservedQty: { decrement: item.quantity }, soldQty: { increment: item.quantity } },
      });
      await tx.inventoryMovement.create({
        data: { variantId: item.variantId, deltaQty: item.quantity, type: 'SALE', reference: order.orderNumber },
      });
    }
    // Shipment record is created once payment is confirmed.
    await tx.shipment.create({ data: { orderId: order.id } });
    return order;
  });
};

// Release reservations if a payment is definitively failed/expired.
export const failOrderPayment = async (orderId: string) => {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order || order.status !== 'PENDING_PAYMENT') return;
  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: orderId }, data: { status: OrderStatus.CANCELLED, paymentStatus: PaymentStatus.FAILED } });
    await tx.orderStatusEvent.create({ data: { orderId, fromStatus: 'PENDING_PAYMENT', toStatus: 'CANCELLED', note: 'Payment failed or abandoned' } });
    for (const item of order.items) {
      if (!item.variantId) continue;
      await tx.inventory.update({
        where: { variantId: item.variantId },
        data: { availableQty: { increment: item.quantity }, reservedQty: { decrement: item.quantity } },
      });
      await tx.inventoryMovement.create({
        data: { variantId: item.variantId, deltaQty: item.quantity, type: 'RELEASE', reference: order.orderNumber },
      });
    }
  });
};
