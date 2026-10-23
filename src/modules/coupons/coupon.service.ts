import { Prisma } from '@prisma/client';
import { ApiError, badRequest } from '../../lib/errors';

/**
 * Coupon domain rules.
 *
 * Money conventions (identical to the rest of the backend):
 *  - all internal amounts are INTEGER PAISE;
 *  - the public API speaks INTEGER RUPEES.
 *
 * Rounding rule (documented contract): a discount is computed in exact paise,
 * capped by the optional maximum, then floored to a WHOLE RUPEE so that every
 * amount shown to the customer (subtotal, discount, total) is an exact rupee
 * integer and the charged total always equals the displayed sum.
 *
 * Minimum order rule: the minimum order value is evaluated against the
 * PRE-DISCOUNT merchandise subtotal. This is applied consistently in the
 * quote endpoint, order creation and all tests.
 *
 * Usage lifecycle: a CouponUsage row (status ACTIVE) is created inside the
 * order-creation transaction while the Coupon row is locked FOR UPDATE, so
 * concurrent checkouts can never exceed usage limits. Pending prepaid
 * attempts count towards the limits (they hold a reservation); the usage is
 * RELEASED (kept for reporting) when the payment fails, the attempt expires,
 * or the order is cancelled.
 */

export type CouponClient = Prisma.TransactionClient;

export interface CouponRecord {
  id: string;
  code: string;
  discountType: string; // PERCENTAGE | FIXED_AMOUNT | FREE_SHIPPING
  discountValue: number; // percent points, or paise for FIXED_AMOUNT
  minimumOrderPaise: number;
  maximumDiscountPaise: number | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  isActive: boolean;
  totalUsageLimit: number | null;
  perCustomerUsageLimit: number | null;
  firstOrderOnly: boolean;
}

export const normalizeCouponCode = (raw: string): string => raw.trim().toUpperCase();

export const couponError = (code: string, message: string, details?: unknown): ApiError =>
  new ApiError(400, code, message, details);

/** Public coupon-status bucket used for listing/filtering. */
export const couponStatusBucket = (c: CouponRecord, now = new Date()): 'DISABLED' | 'SCHEDULED' | 'ACTIVE' | 'EXPIRED' => {
  if (!c.isActive) return 'DISABLED';
  if (c.startsAt && c.startsAt > now) return 'SCHEDULED';
  if (c.expiresAt && c.expiresAt < now) return 'EXPIRED';
  return 'ACTIVE';
};

/** Exact-paise discount, capped, then floored to a whole rupee. */
export const computeDiscountPaise = (coupon: CouponRecord, subtotalPaise: number): number => {
  if (subtotalPaise <= 0) return 0;
  if (coupon.discountType === 'FREE_SHIPPING') return 0;
  let discountPaise: number;
  if (coupon.discountType === 'PERCENTAGE') {
    // percent points: 10 => 10% of subtotal
    discountPaise = Math.floor((subtotalPaise * coupon.discountValue) / 100);
  } else {
    discountPaise = coupon.discountValue;
  }
  if (coupon.maximumDiscountPaise !== null && coupon.maximumDiscountPaise !== undefined) {
    discountPaise = Math.min(discountPaise, coupon.maximumDiscountPaise);
  }
  // Whole-rupee floor: the public API and frontend display integer rupees.
  discountPaise = Math.floor(discountPaise / 100) * 100;
  // Never reduce the payable merchandise subtotal below zero.
  return Math.max(0, Math.min(discountPaise, subtotalPaise));
};

export interface CartLine {
  variantId: string;
  productId: string;
  quantity: number;
  unitPricePaise: number;
}

export interface ValidatedCoupon {
  coupon: CouponRecord;
  discountPaise: number;
  freeShipping: boolean;
}

export interface ValidateCouponInput {
  code: string;
  subtotalPaise: number;
  cartLines: CartLine[];
  userId: string | null;
  email: string | null;
}

const activeUsageWhere = (couponId: string) => ({ couponId, status: 'ACTIVE' } as const);

/**
 * Validate a coupon against a cart. Read-only (usage counting uses the passed
 * Prisma client so the order-creation transaction sees a consistent snapshot
 * under the coupon row lock).
 */
export const validateCoupon = async (client: CouponClient, input: ValidateCouponInput): Promise<ValidatedCoupon> => {
  const code = normalizeCouponCode(input.code);
  const coupon = (await client.coupon.findUnique({
    where: { code },
    include: { products: { select: { productId: true } } },
  })) as (CouponRecord & { products: { productId: string }[] }) | null;

  if (!coupon) throw couponError('COUPON_INVALID', 'This coupon code is not valid.');
  if (!coupon.isActive) throw couponError('COUPON_DISABLED', 'This coupon is currently disabled.');
  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) {
    throw couponError('COUPON_NOT_STARTED', 'This coupon is not active yet.');
  }
  if (coupon.expiresAt && coupon.expiresAt < now) {
    throw couponError('COUPON_EXPIRED', 'This coupon has expired.');
  }

  // Product eligibility: when the coupon is restricted to specific products,
  // the cart must contain at least one of them.
  if (coupon.products.length > 0) {
    const allowed = new Set(coupon.products.map((p) => p.productId));
    const eligible = input.cartLines.some((l) => allowed.has(l.productId));
    if (!eligible) {
      throw couponError('COUPON_NOT_APPLICABLE', 'This coupon does not apply to the items in your bag.');
    }
  }

  // Minimum order value is evaluated against the PRE-discount subtotal.
  if (input.subtotalPaise < coupon.minimumOrderPaise) {
    throw couponError('COUPON_MIN_ORDER_NOT_MET', 'Add more items to use this coupon.', {
      minimumOrderRupees: Math.ceil(coupon.minimumOrderPaise / 100),
    });
  }

  // Total usage limit.
  if (coupon.totalUsageLimit !== null) {
    const used = await client.couponUsage.count({ where: activeUsageWhere(coupon.id) });
    if (used >= coupon.totalUsageLimit) {
      throw couponError('COUPON_USAGE_LIMIT_REACHED', 'This coupon has reached its usage limit.');
    }
  }

  // Per-customer usage limit.
  if (coupon.perCustomerUsageLimit !== null) {
    const identity = input.userId ? { userId: input.userId } : input.email ? { email: input.email } : null;
    if (identity) {
      const usedByCustomer = await client.couponUsage.count({
        where: { ...activeUsageWhere(coupon.id), ...identity },
      });
      if (usedByCustomer >= coupon.perCustomerUsageLimit) {
        throw couponError('COUPON_CUSTOMER_LIMIT_REACHED', 'You have already used this coupon.');
      }
    }
  }

  // First-order-only: no previous non-cancelled order for this identity.
  if (coupon.firstOrderOnly) {
    const hasOrdered = input.userId
      ? await client.order.count({ where: { userId: input.userId, status: { not: 'CANCELLED' } } })
      : input.email
        ? await client.order.count({ where: { email: input.email, status: { not: 'CANCELLED' } } })
        : -1; // anonymous, unverifiable
    if (hasOrdered !== 0) {
      throw couponError('COUPON_FIRST_ORDER_ONLY', 'This coupon is only valid on your first order.');
    }
  }

  const discountPaise = computeDiscountPaise(coupon, input.subtotalPaise);
  if (coupon.discountType !== 'FREE_SHIPPING' && discountPaise <= 0) {
    // A fixed coupon worth less than one rupee, or fully clamped: not usable.
    throw couponError('COUPON_NOT_APPLICABLE', 'This coupon does not apply to the items in your bag.');
  }
  return { coupon, discountPaise, freeShipping: coupon.discountType === 'FREE_SHIPPING' };
};

/**
 * Atomically claim a coupon for an order. MUST run inside the order-creation
 * transaction: the Coupon row is locked FOR UPDATE first, so concurrent
 * checkouts serialise and usage limits can never be exceeded.
 */
export const claimCouponForOrder = async (
  tx: CouponClient,
  input: ValidateCouponInput & { orderId: string },
): Promise<ValidatedCoupon> => {
  const code = normalizeCouponCode(input.code);
  await tx.$queryRaw`SELECT id FROM "Coupon" WHERE code = ${code} FOR UPDATE`;
  const validated = await validateCoupon(tx, input);
  await tx.couponUsage.create({
    data: {
      couponId: validated.coupon.id,
      orderId: input.orderId,
      userId: input.userId,
      email: input.email ?? '',
      discountPaise: validated.discountPaise,
      status: 'ACTIVE',
    },
  });
  return validated;
};

/** Release the coupon usage of a failed/expired/cancelled order (idempotent). */
export const releaseCouponUsage = async (tx: CouponClient, orderId: string, reason: string): Promise<void> => {
  await tx.couponUsage.updateMany({
    where: { orderId, status: 'ACTIVE' },
    data: { status: 'RELEASED', releaseReason: reason, releasedAt: new Date() },
  });
};

/** Safe public representation (no internal notes, limits or admin fields). */
export const publicCouponShape = (
  c: CouponRecord & { publicDescription: string | null; promotionalHeadline: string | null; campaignBadge: string | null; displayPriority: number; isPublic: boolean },
  eligibleProductIds?: Set<string>,
) => {
  const discountDisplay =
    c.discountType === 'PERCENTAGE'
      ? c.discountValue + '% off'
      : c.discountType === 'FREE_SHIPPING'
        ? 'Free shipping'
        : '₹' + Math.round(c.discountValue / 100) + ' off';
  return {
    code: c.code,
    headline: c.promotionalHeadline ?? null,
    description: c.publicDescription ?? null,
    discountType: c.discountType,
    discountDisplay,
    minimumOrderRupees: c.minimumOrderPaise > 0 ? Math.ceil(c.minimumOrderPaise / 100) : null,
    maximumDiscountRupees:
      c.discountType === 'PERCENTAGE' && c.maximumDiscountPaise ? Math.round(c.maximumDiscountPaise / 100) : null,
    expiresAt: c.expiresAt,
    badge: c.campaignBadge ?? null,
    appliesToProducts: eligibleProductIds ? [...eligibleProductIds] : undefined,
  };
};

/** Guard used by admin routes for enum-ish fields. */
export const assertDiscountShape = (discountType: string, discountValue: number): void => {
  if (discountType === 'PERCENTAGE' && (!Number.isInteger(discountValue) || discountValue < 1 || discountValue > 100)) {
    throw badRequest('A percentage discount must be a whole number between 1 and 100.');
  }
  if (discountType === 'FIXED_AMOUNT' && (!Number.isInteger(discountValue) || discountValue < 100)) {
    throw badRequest('A fixed discount must be at least ₹1.');
  }
};
