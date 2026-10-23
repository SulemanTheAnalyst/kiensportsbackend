import { OrderStatus, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { notFound, forbidden, ApiError, badRequest } from '../../lib/errors';
import { computeTotals, paiseToRupees, rupeesToPaise } from '../../lib/money';
import { env } from '../../config/env';
import { recordBusinessEvent, orderNotificationPayload } from '../notifications/notifications';
import { generateOrderNumber } from '../../lib/ids';
import { getOrCreateCart } from '../cart/cart.session';
import { validateCartForCheckout } from '../cart/cart.service';
import type { Request } from 'express';
import { paymentService } from '../payment/payment.service';
import { notifyOrderConfirmed } from '../email/order.emails';
import { getCodBounds, getSettings, getShippingRule } from '../settings/settings.service';
import {
  checkCustomerEligibility,
  evaluateLoadedCoupon,
  findCouponByCode,
  redeemCouponInTx,
  releaseCouponRedemptionInTx,
} from '../coupon/coupon.service';

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
  input: { email: string; address: AddressInput; method: PaymentMethod; couponCode?: string | null },
) => {
  const cart = await getOrCreateCart(req);
  if (cart.items.length === 0) throw new ApiError(400, 'CART_EMPTY', 'Your bag is empty');

  await validateCartForCheckout(cart);

  const email = input.email.toLowerCase();
  // Shipping rule + COD bounds are read BEFORE the transaction (no long-held
  // locks over config reads). The backend owns every value: prices come from
  // the database, discounts from the coupon engine - never from the client.
  const shippingRule = await getShippingRule();
  const codBounds = await getCodBounds(env.COD_MAX_ORDER_VALUE_RUPEES);
  const { checkout: checkoutSettings } = await getSettings();

  // Optional coupon: resolve + pre-evaluate outside the transaction, then
  // RE-VALIDATE under the coupon row lock inside it (see below) so concurrent
  // checkouts can never exceed usage limits.
  let couponRow: Awaited<ReturnType<typeof findCouponByCode>> = null;
  if (input.couponCode) {
    couponRow = await findCouponByCode(input.couponCode);
    if (!couponRow) throw badRequest('That coupon code does not exist.');
  }

  const created = await prisma.$transaction(async (tx) => {
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
    const subtotalPaise = lines.reduce((a, l) => a + l.lineTotalPaise, 0);

    // ---- Payment method eligibility (Settings -> Payments & Checkout) ----
    const isCod = input.method === PaymentMethod.COD;
    if (!isCod && !checkoutSettings.prepaidEnabled) {
      throw badRequest('Prepaid checkout is currently unavailable. Please choose Cash on Delivery.');
    }
    if (isCod && !checkoutSettings.codEnabled) {
      throw badRequest('Cash on Delivery is currently unavailable. Please pay online.');
    }
    if (isCod && codBounds.minRupees > 0 && subtotalPaise < rupeesToPaise(codBounds.minRupees)) {
      throw badRequest('Cash on delivery is available for orders of ₹' + codBounds.minRupees + ' and above.');
    }
    if (isCod && codBounds.effectiveMaxRupees > 0 && subtotalPaise > rupeesToPaise(codBounds.effectiveMaxRupees)) {
      throw badRequest('Cash on delivery is not available for orders above ₹' + codBounds.effectiveMaxRupees);
    }

    // ---- Coupon (server-authoritative; the client supplies ONLY the code) ----
    // A coupon row lock (FOR UPDATE) serializes concurrent redemptions; the
    // validity, usage limits and the discount are all RE-EVALUATED inside the
    // lock, so races cannot exhaust limits. The minimum order value is
    // evaluated against the PRE-DISCOUNT eligible subtotal (documented rule).
    let couponDiscountPaise = 0;
    let couponFreeShipping = false;
    let appliedCoupon: { id: string; code: string } | null = null;
    if (couponRow) {
      await tx.$queryRaw`SELECT id FROM "Coupon" WHERE id = ${couponRow.id} FOR UPDATE`;
      // Fresh read under the lock: timesUsed may have changed concurrently.
      const fresh = await tx.coupon.findUniqueOrThrow({
        where: { id: couponRow.id },
        include: { products: { select: { productId: true } } },
      });
      const cartLines = {
        items: lines.map((l) => ({
          variantId: l.variantId,
          productId: cart.items.find((i) => i.variantId === l.variantId)!.variant.productId,
          quantity: l.quantity,
          unitPricePaise: l.unitPricePaise,
        })),
      };
      const evaluation = evaluateLoadedCoupon(fresh, cartLines, { userId: req.user?.sub ?? null, email: '' }, shippingRule);
      if (!evaluation.ok) throw new ApiError(400, evaluation.code, evaluation.message);
      const customerCheck = await checkCustomerEligibility(tx, fresh, { userId: req.user?.sub ?? null, email });
      if (customerCheck && !customerCheck.ok) throw new ApiError(400, customerCheck.code, customerCheck.message);
      couponDiscountPaise = evaluation.discountPaise;
      couponFreeShipping = evaluation.freeShipping;
      appliedCoupon = { id: fresh.id, code: fresh.code };
    }

    // Shipping is evaluated on the PRE-DISCOUNT subtotal; a FREE_SHIPPING
    // coupon zeroes the charge itself. Totals are then discount-adjusted.
    const baseTotals = computeTotals(
      lines.map((l) => ({ unitPricePaise: l.unitPricePaise, quantity: l.quantity })),
      shippingRule,
    );
    const shippingForOrder = couponFreeShipping ? 0 : baseTotals.shippingPaise;
    const totals = {
      subtotalPaise: baseTotals.subtotalPaise,
      discountPaise: couponDiscountPaise,
      shippingPaise: shippingForOrder,
      taxPaise: baseTotals.taxPaise,
      totalPaise: Math.max(0, baseTotals.subtotalPaise - couponDiscountPaise + shippingForOrder + baseTotals.taxPaise),
    };

    // A COD checkout is a valid business order immediately: CONFIRMED with a
    // COD_PENDING payment state, fulfilled without an online payment, and
    // only marked PAID when the cash is collected (admin collect-cod action).
    // A prepaid checkout stays PENDING_PAYMENT: it is a payment attempt, not
    // a confirmed order, until the verified provider webhook confirms it.
    const created = await tx.order.create({
      data: {
        orderNumber: generateOrderNumber(),
        userId: req.user?.sub ?? null,
        email,
        status: isCod ? OrderStatus.CONFIRMED : undefined,
        paymentStatus: isCod ? PaymentStatus.COD_PENDING : undefined,
        placedAt: isCod ? new Date() : undefined,
        subtotalPaise: totals.subtotalPaise,
        discountPaise: totals.discountPaise,
        couponId: appliedCoupon?.id ?? null,
        couponCode: appliedCoupon?.code ?? null,
        shippingPaise: totals.shippingPaise,
        taxPaise: totals.taxPaise,
        totalPaise: totals.totalPaise,
        shippingAddress: input.address as unknown as Prisma.InputJsonValue,
        items: { create: lines.map(({ variantId, ...rest }) => ({ ...rest, variant: { connect: { id: variantId } } })) },
        statusEvents: {
          create: isCod
            ? { fromStatus: 'NONE', toStatus: 'CONFIRMED', note: 'COD order accepted - payment due on delivery' }
            : { fromStatus: 'NONE', toStatus: 'PENDING_PAYMENT', note: 'Order created' },
        },
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

    // Consume the coupon usage reservation inside the same transaction
    // (mirrors the inventory reservation; released on failure/expiry/cancel).
    if (appliedCoupon) {
      await redeemCouponInTx(tx, {
        couponId: appliedCoupon.id,
        orderId: created.id,
        userId: req.user?.sub ?? null,
        email,
        discountPaise: couponDiscountPaise,
      });
    }

    return created;
  }, { timeout: 15000 });

  // The snapshot captured inside the transaction predates the payment row
  // created later in the same transaction (its `payments` include is empty).
  // Re-fetch the complete order so the provider session can be created from it.
  const order = await prisma.order.findUniqueOrThrow({ where: { id: created.id }, include: orderInclude });

  // Provider session creation happens outside the DB transaction.
  const payment = await paymentService.createPaymentSession(order);

  if (input.method === PaymentMethod.COD) {
    // The COD checkout is complete and valid: notify the customer and the
    // business exactly once (marker-based email dedupe + outbox dedupe key).
    notifyOrderConfirmed(order.orderNumber);
    await recordBusinessEvent('ORDER_CREATED', 'ORDER_CREATED:' + order.id, orderNotificationPayload(order));
  }
  // Prepaid: the order stays PENDING_PAYMENT and no order-created notification
  // is sent until the payment is verified via the provider webhook.
  return { order, payment };
};

export const serializeOrder = (order: Prisma.OrderGetPayload<{ include: typeof orderInclude }>, withEvents = false) => {
  const base = {
    id: order.id,
    orderNumber: order.orderNumber,
    email: order.email,
    status: order.status,
    paymentStatus: order.paymentStatus,
    subtotal: paiseToRupees(order.subtotalPaise),
    discount: paiseToRupees(order.discountPaise),
    couponCode: order.couponCode ?? null,
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
//
// The order row is locked FOR UPDATE first, so this can never race with the
// expiry sweep or an admin cancellation: an attempt that already expired
// (CANCELLED) can never be resurrected by a delayed webhook. If money
// genuinely arrived after the order was closed, the capture is recorded and
// flagged for manual reconciliation/refund instead of confirming a dead order.
export const confirmOrderPayment = async (providerPaymentId: string) => {
  const payment = await prisma.payment.findFirst({
    where: { providerPaymentId },
    include: { order: { include: { items: true } } },
  });
  if (!payment) throw notFound('Payment not found for ' + providerPaymentId);
  if (payment.status === 'CAPTURED' && payment.webhookVerifiedAt) {
    return payment.order; // idempotent replay
  }

  let late = false;
  const confirmed = await prisma.$transaction(async (tx) => {
    // Serialize against expiry/cancellation for the same order.
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${payment.orderId} FOR UPDATE`;
    const current = await tx.order.findUniqueOrThrow({
      where: { id: payment.orderId },
      include: { items: true, payments: true },
    });

    if (current.status !== OrderStatus.PENDING_PAYMENT) {
      // The attempt already expired or was cancelled. The payment may still
      // have captured at the provider: record it for reconciliation, but
      // NEVER re-confirm the order or re-deduct inventory.
      late = true;
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: 'CAPTURED', webhookVerifiedAt: new Date(), providerPaymentId },
      });
      await tx.orderStatusEvent.create({
        data: {
          orderId: current.id,
          fromStatus: current.status,
          toStatus: current.status,
          note: 'Verified payment arrived after the order was closed - manual reconciliation/refund required',
        },
      });
      return current;
    }

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
    // Convert reservations into sales - exactly once (guarded by the row lock
    // and the PENDING_PAYMENT check above; replays return early).
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

  if (late) {
    // Money moved for a closed attempt: alert the business exactly once.
    await recordBusinessEvent(
      'PAYMENT_LATE',
      'PAYMENT_LATE:' + payment.id,
      orderNotificationPayload(confirmed, {
        reason: 'Verified payment captured after the order expired/was cancelled - refund or reconcile manually',
      }),
    );
    return confirmed;
  }

  // Transaction committed and payment VERIFIED: safe to notify the customer
  // and the business. Best-effort, idempotent (replays of an already-captured
  // payment return above and never reach this line). Never inside the tx.
  notifyOrderConfirmed(confirmed.orderNumber);
  await recordBusinessEvent('ORDER_CREATED', 'ORDER_CREATED:' + confirmed.id, orderNotificationPayload(confirmed));
  await recordBusinessEvent(
    'PAYMENT_SUCCEEDED',
    'PAYMENT_SUCCEEDED:' + payment.id,
    orderNotificationPayload(confirmed, { reason: 'Verified webhook confirmed the payment' }),
  );
  return confirmed;
};

// Release reservations if a payment is definitively failed/expired.
// Returns true when the order actually transitioned (callers rely on this to
// send the failure notification exactly once).
export const failOrderPayment = async (orderId: string, reason = 'Payment failed or abandoned') => {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, payments: true },
  });
  if (!order || order.status !== OrderStatus.PENDING_PAYMENT) return false;
  let transitioned = false;
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const fresh = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!fresh || fresh.status !== OrderStatus.PENDING_PAYMENT) return;
    transitioned = true;
    await tx.order.update({ where: { id: orderId }, data: { status: OrderStatus.CANCELLED, paymentStatus: PaymentStatus.FAILED } });
    await tx.orderStatusEvent.create({ data: { orderId, fromStatus: 'PENDING_PAYMENT', toStatus: 'CANCELLED', note: reason } });
    // The failed attempt releases its coupon usage reservation as well.
    await releaseCouponRedemptionInTx(tx, orderId, 'Payment failed: ' + reason);
    for (const item of fresh.items) {
      if (!item.variantId) continue;
      await tx.inventory.update({
        where: { variantId: item.variantId },
        data: { availableQty: { increment: item.quantity }, reservedQty: { decrement: item.quantity } },
      });
      await tx.inventoryMovement.create({
        data: { variantId: item.variantId, deltaQty: item.quantity, type: 'RELEASE', reference: fresh.orderNumber },
      });
    }
  });
  if (!transitioned) return false;
  await recordBusinessEvent(
    'PAYMENT_FAILED',
    'PAYMENT_FAILED:' + orderId,
    orderNotificationPayload({ ...order, paymentStatus: PaymentStatus.FAILED }, { reason }),
  );
  return true;
};

// ---- Prepaid attempt expiry (abandonment) ----
// An unpaid prepaid attempt is never assumed abandoned just because payment
// has not arrived; it expires only after the configured TTL
// (PENDING_PAYMENT_TTL_MINUTES). Expiry releases the inventory reservation
// safely and can never race with a verified webhook: both paths lock the
// order row and re-check the PENDING_PAYMENT status inside the transaction.

const expireOrderInTx = async (
  order: Prisma.OrderGetPayload<{ include: { items: true; payments: true } }>,
): Promise<boolean> => {
  const transitioned = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
    const fresh = await tx.order.findUnique({ where: { id: order.id } });
    if (!fresh || fresh.status !== OrderStatus.PENDING_PAYMENT) return false;
    await tx.payment.updateMany({ where: { orderId: order.id, status: 'CREATED' }, data: { status: 'EXPIRED' } });
    await tx.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.CANCELLED, paymentStatus: PaymentStatus.FAILED },
    });
    await tx.orderStatusEvent.create({
      data: {
        orderId: order.id,
        fromStatus: 'PENDING_PAYMENT',
        toStatus: 'CANCELLED',
        note: 'Payment attempt expired (TTL ' + env.PENDING_PAYMENT_TTL_MINUTES + ' minutes)',
      },
    });
    // The expired attempt releases its coupon usage reservation as well.
    await releaseCouponRedemptionInTx(tx, order.id, 'Payment attempt expired');
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
    return true;
  });
  if (transitioned) {
    await recordBusinessEvent(
      'PAYMENT_EXPIRED',
      'PAYMENT_EXPIRED:' + order.id,
      orderNotificationPayload(order, { reason: 'Payment attempt expired after the configured timeout' }),
    );
  }
  return transitioned;
};

// Expire one stale attempt (used by the lightweight public status poll).
export const expirePendingOrderIfStale = async (orderNumber: string) => {
  if (env.PENDING_PAYMENT_TTL_MINUTES <= 0) return false;
  const order = await prisma.order.findUnique({
    where: { orderNumber },
    include: { items: true, payments: true },
  });
  if (!order || order.status !== OrderStatus.PENDING_PAYMENT) return false;
  const cutoff = new Date(Date.now() - env.PENDING_PAYMENT_TTL_MINUTES * 60_000);
  if (order.createdAt >= cutoff) return false;
  return expireOrderInTx(order);
};

// Ops sweep (admin endpoint / scheduled cron): expire every stale attempt.
export const expireStalePendingPayments = async () => {
  if (env.PENDING_PAYMENT_TTL_MINUTES <= 0) return 0;
  const cutoff = new Date(Date.now() - env.PENDING_PAYMENT_TTL_MINUTES * 60_000);
  const stale = await prisma.order.findMany({
    where: { status: OrderStatus.PENDING_PAYMENT, createdAt: { lt: cutoff } },
    include: { items: true, payments: true },
    take: 100,
  });
  let expired = 0;
  for (const order of stale) {
    if (await expireOrderInTx(order)) expired += 1;
  }
  return expired;
};
