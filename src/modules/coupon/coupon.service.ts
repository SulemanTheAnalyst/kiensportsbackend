import { DiscountType, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ApiError } from '../../lib/errors';
import { applyDiscountToTotals, type ShippingRule } from '../../lib/money';

// Coupon validation + calculation. The backend is the ONLY authority:
// the frontend never supplies a discount amount, only a code. All money is
// integer paise; percentages are whole numbers.
//
// DOCUMENTED RULES (enforced consistently everywhere):
//  1. The minimum order value is evaluated against the PRE-DISCOUNT
//     merchandise subtotal of the eligible items - never against the
//     post-discount total, never including shipping.
//  2. Percentage discounts are computed on the eligible subtotal and
//     floored to whole paise, then capped at maximumDiscountPaise.
//  3. A discount can never reduce the merchandise subtotal below zero.
//  4. Product eligibility: when a coupon has product restrictions, only
//     the restricted products' lines are eligible; the discount applies
//     only to the eligible subtotal. No eligible items -> NOT_APPLICABLE.
//  5. Usage is consumed only when an ORDER is created (a reservation),
//     never when a customer clicks Apply. Failed/expired/cancelled
//     attempts release the reservation.

export interface CouponLike {
  id: string;
  code: string;
  internalName: string;
  discountType: DiscountType;
  discountValue: number;
  minimumOrderPaise: number;
  maximumDiscountPaise: number | null;
  startsAt: Date;
  expiresAt: Date | null;
  isActive: boolean;
  totalUsageLimit: number | null;
  perCustomerUsageLimit: number | null;
  firstOrderOnly: boolean;
  timesUsed: number;
}

export type CouponEvaluation =
  | {
      ok: true;
      couponId: string;
      code: string;
      discountType: DiscountType;
      discountPaise: number;
      eligibleSubtotalPaise: number;
      freeShipping: boolean;
      description: string;
    }
  | { ok: false; code: string; message: string };

export const couponError = (code: string, message: string): CouponEvaluation => ({ ok: false, code, message });

const COUPON_ERRORS = {
  INVALID: 'That coupon code is not valid.',
  NOT_FOUND: 'That coupon code does not exist.',
  INACTIVE: 'This coupon is currently disabled.',
  NOT_STARTED: 'This coupon is not active yet.',
  EXPIRED: 'This coupon has expired.',
  EXHAUSTED: 'This coupon has reached its usage limit.',
  CUSTOMER_LIMIT: 'You have already used this coupon the maximum number of times.',
  FIRST_ORDER: 'This coupon is only valid on your first order.',
  MIN_ORDER: (amount: number) => 'Add items worth ₹' + amount + ' to use this coupon.',
  NOT_APPLICABLE: 'This coupon is not applicable to the items in your bag.',
} as const;

export const findCouponByCode = async (code: string) => {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  return prisma.coupon.findUnique({ where: { code: normalized }, include: { products: true } });
};

export const normalizeCode = (code: string) => code.trim().toUpperCase().slice(0, 40);

// Pure calculation: discount in paise for a given eligible subtotal.
// Assumes the coupon is otherwise valid; clamps to [0, eligibleSubtotal].
export const computeDiscountPaise = (
  coupon: Pick<CouponLike, 'discountType' | 'discountValue' | 'maximumDiscountPaise'>,
  eligibleSubtotalPaise: number,
): number => {
  let discount = 0;
  if (coupon.discountType === DiscountType.PERCENT) {
    discount = Math.floor((eligibleSubtotalPaise * coupon.discountValue) / 100);
    if (coupon.maximumDiscountPaise !== null && coupon.maximumDiscountPaise !== undefined) {
      discount = Math.min(discount, coupon.maximumDiscountPaise);
    }
  } else if (coupon.discountType === DiscountType.FIXED) {
    discount = coupon.discountValue;
  }
  // FREE_SHIPPING contributes 0 merchandise discount; the caller zeroes shipping.
  return Math.max(0, Math.min(discount, eligibleSubtotalPaise));
};

export interface CartLines {
  items: { variantId: string; productId: string; quantity: number; unitPricePaise: number }[];
}

// Full read-only evaluation (used by the public validate endpoint and,
// re-run transactionally, at order creation).
export const evaluateCoupon = async (
  couponId: string,
  cart: CartLines,
  customer: { userId: string | null; email: string },
  shippingRule: ShippingRule,
): Promise<CouponEvaluation> => {
  const coupon = await prisma.coupon.findUnique({
    where: { id: couponId },
    include: { products: { select: { productId: true } } },
  });
  if (!coupon) return couponError('COUPON_NOT_FOUND', COUPON_ERRORS.NOT_FOUND);
  return evaluateLoadedCoupon(coupon, cart, customer, shippingRule);
};

export const evaluateLoadedCoupon = (
  coupon: Prisma.CouponGetPayload<{ include: { products: { select: { productId: true } } } }>,
  cart: CartLines,
  customer: { userId: string | null; email: string },
  shippingRule: ShippingRule,
): CouponEvaluation => {
  if (!coupon.isActive) return couponError('COUPON_INACTIVE', COUPON_ERRORS.INACTIVE);
  const now = new Date();
  if (coupon.startsAt > now) return couponError('COUPON_NOT_STARTED', COUPON_ERRORS.NOT_STARTED);
  if (coupon.expiresAt && coupon.expiresAt <= now) return couponError('COUPON_EXPIRED', COUPON_ERRORS.EXPIRED);
  if (coupon.totalUsageLimit !== null && coupon.timesUsed >= coupon.totalUsageLimit) {
    return couponError('COUPON_EXHAUSTED', COUPON_ERRORS.EXHAUSTED);
  }

  // Product eligibility.
  const restrictedIds = coupon.products.length > 0 ? new Set(coupon.products.map((p) => p.productId)) : null;
  const eligibleItems = restrictedIds ? cart.items.filter((i) => restrictedIds.has(i.productId)) : cart.items;
  if (eligibleItems.length === 0) return couponError('COUPON_NOT_APPLICABLE', COUPON_ERRORS.NOT_APPLICABLE);
  const eligibleSubtotalPaise = eligibleItems.reduce((a, i) => a + i.unitPricePaise * i.quantity, 0);

  // Minimum order is evaluated BEFORE the discount, on eligible items only.
  if (coupon.minimumOrderPaise > 0 && eligibleSubtotalPaise < coupon.minimumOrderPaise) {
    return couponError('MIN_ORDER_NOT_MET', COUPON_ERRORS.MIN_ORDER(Math.ceil(coupon.minimumOrderPaise / 100)));
  }

  const discountPaise = computeDiscountPaise(coupon, eligibleSubtotalPaise);
  const freeShipping = coupon.discountType === DiscountType.FREE_SHIPPING;
  const shipping = freeShipping
    ? 0
    : eligibleItems.length === cart.items.length
      ? (eligibleSubtotalPaise >= shippingRule.freeShippingThresholdPaise ? 0 : shippingRule.flatShippingPaise)
      : null; // mixed eligibility: caller computes shipping on the full subtotal
  if (shipping === null) {
    // A free-shipping coupon restricted to a subset of the cart still
    // applies to the whole order's shipping; percentage/fixed discounts on a
    // subset only discount the eligible subtotal.
    return {
      ok: true,
      couponId: coupon.id,
      code: coupon.code,
      discountType: coupon.discountType,
      discountPaise,
      eligibleSubtotalPaise,
      freeShipping,
      description: describeDiscount(coupon),
    };
  }

  return {
    ok: true,
    couponId: coupon.id,
    code: coupon.code,
    discountType: coupon.discountType,
    discountPaise,
    eligibleSubtotalPaise,
    freeShipping,
    description: describeDiscount(coupon),
  };
};

export const describeDiscount = (
  coupon: Pick<CouponLike, 'discountType' | 'discountValue' | 'maximumDiscountPaise'>,
): string => {
  if (coupon.discountType === DiscountType.PERCENT) {
    let s = coupon.discountValue + '% off';
    if (coupon.maximumDiscountPaise) s += ' (up to ₹' + Math.ceil(coupon.maximumDiscountPaise / 100) + ')';
    return s;
  }
  if (coupon.discountType === DiscountType.FREE_SHIPPING) return 'Free shipping';
  return '₹' + Math.ceil(coupon.discountValue / 100) + ' off';
};

// Customer-level checks that need database reads (used by validate AND
// re-checked inside the order transaction under a coupon row lock).
export const checkCustomerEligibility = async (
  tx: Pick<Prisma.TransactionClient, 'couponRedemption' | 'order'> | Prisma.TransactionClient,
  coupon: Pick<CouponLike, 'id' | 'perCustomerUsageLimit' | 'firstOrderOnly'>,
  customer: { userId: string | null; email: string },
): Promise<CouponEvaluation | null> => {
  if (coupon.perCustomerUsageLimit !== null && coupon.perCustomerUsageLimit > 0) {
    const used = await tx.couponRedemption.count({
      where: {
        couponId: coupon.id,
        releasedAt: null,
        OR: [...(customer.userId ? [{ userId: customer.userId }] : []), { email: customer.email }],
      },
    });
    if (used >= coupon.perCustomerUsageLimit) {
      return couponError('COUPON_CUSTOMER_LIMIT', COUPON_ERRORS.CUSTOMER_LIMIT);
    }
  }
  if (coupon.firstOrderOnly) {
    const priorOrders = await tx.order.count({
      where: {
        paymentStatus: 'PAID',
        OR: [...(customer.userId ? [{ userId: customer.userId }] : []), { email: customer.email }],
      },
    });
    if (priorOrders > 0) return couponError('COUPON_FIRST_ORDER_ONLY', COUPON_ERRORS.FIRST_ORDER);
  }
  return null;
};

// ---- Redemption lifecycle ----
// Reserve usage at order creation: the coupon row is locked FOR UPDATE by
// the caller (createOrder transaction) before calling this, so concurrent
// checkouts can never exceed totalUsageLimit.
export const redeemCouponInTx = async (
  tx: Prisma.TransactionClient,
  input: {
    couponId: string;
    orderId: string;
    userId: string | null;
    email: string;
    discountPaise: number;
  },
) => {
  await tx.couponRedemption.create({
    data: {
      couponId: input.couponId,
      orderId: input.orderId,
      userId: input.userId,
      email: input.email.toLowerCase(),
      discountPaise: input.discountPaise,
    },
  });
  await tx.coupon.update({ where: { id: input.couponId }, data: { timesUsed: { increment: 1 } } });
};

// Release a reservation when the attempt fails/expires or the order is
// cancelled. Idempotent: releasing twice has no effect.
export const releaseCouponRedemptionInTx = async (tx: Prisma.TransactionClient, orderId: string, reason: string) => {
  const redemption = await tx.couponRedemption.findUnique({ where: { orderId } });
  if (!redemption || redemption.releasedAt) return false;
  await tx.couponRedemption.update({
    where: { id: redemption.id },
    data: { releasedAt: new Date(), releasedReason: reason.slice(0, 300) },
  });
  await tx.coupon.update({
    where: { id: redemption.couponId },
    data: { timesUsed: { decrement: 1 } },
  });
  return true;
};

// ---- Cart totals with coupon (server-authoritative) ----
export interface CartTotalsInput {
  subtotalPaise: number;
  shippingPaise: number;
  taxPaise: number;
  coupon?: { code: string; discountPaise: number; freeShipping: boolean } | null;
}

export const totalsWithCoupon = (input: CartTotalsInput) => {
  if (!input.coupon) {
    return applyDiscountToTotals(
      { subtotalPaise: input.subtotalPaise, shippingPaise: input.shippingPaise, taxPaise: input.taxPaise },
      0,
    );
  }
  const shippingPaise = input.coupon.freeShipping ? 0 : input.shippingPaise;
  return applyDiscountToTotals(
    { subtotalPaise: input.subtotalPaise, shippingPaise, taxPaise: input.taxPaise },
    input.coupon.discountPaise,
  );
};

// Public (customer-facing) coupon shape - only safe fields.
export const toPublicCoupon = (
  coupon: Prisma.CouponGetPayload<{ include: { products: { select: { productId: true } } } }>,
) => ({
  code: coupon.code,
  discountType: coupon.discountType,
  description: describeDiscount(coupon),
  publicDescription: coupon.publicDescription,
  promoHeadline: coupon.promoHeadline,
  minimumOrderRupees: coupon.minimumOrderPaise ? Math.ceil(coupon.minimumOrderPaise / 100) : null,
  maximumDiscountRupees: coupon.maximumDiscountPaise ? Math.ceil(coupon.maximumDiscountPaise / 100) : null,
  expiresAt: coupon.expiresAt,
  displayPriority: coupon.displayPriority,
  // Eligible product ids let the storefront show offers only on products
  // they actually apply to. Empty array = all products.
  productIds: coupon.products.map((p) => p.productId),
});

// Throw helper: converts an evaluation failure into an ApiError with the
// same machine-readable code, so the API can return consistent envelopes.
export const evaluationToApiError = (evaluation: CouponEvaluation): ApiError =>
  new ApiError(400, evaluation.code, evaluation.message);
