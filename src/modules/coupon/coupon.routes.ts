import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { validate } from '../../middleware/validate';
import { optionalAuth } from '../../middleware/auth';
import { apiLimiter } from '../../middleware/errorHandler';
import { ApiError, badRequest } from '../../lib/errors';
import { paiseToRupees } from '../../lib/money';
import { getOrCreateCart } from '../cart/cart.session';
import { getShippingRule } from '../settings/settings.service';
import {
  checkCustomerEligibility,
  evaluateCoupon,
  findCouponByCode,
  toPublicCoupon,
  totalsWithCoupon,
} from './coupon.service';

// Public coupon endpoints. Only ACTIVE, PUBLIC, currently-valid coupons with
// remaining usage are ever listed; private campaigns and internal fields
// (internalName, limits, admin notes) are never exposed. Discount amounts
// are always calculated server-side from the real cart - a client-supplied
// amount is never accepted.

export const couponRouter = Router();
couponRouter.use(optionalAuth);

// Public listing for storefront promo sections / product pages.
couponRouter.get('/', async (req, res) => {
  const now = new Date();
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
  // Optional product filter: ?productId=... returns coupons applicable to
  // that product (either unrestricted or explicitly including it).
  const productId = typeof req.query.productId === 'string' ? req.query.productId : undefined;

  const coupons = await prisma.coupon.findMany({
    where: {
      isActive: true,
      isPublic: true,
      startsAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    include: { products: { select: { productId: true } } },
    orderBy: [{ displayPriority: 'desc' }, { createdAt: 'desc' }],
    take: 60,
  });

  // Hide exhausted coupons and (when filtered) non-applicable ones.
  const visible = coupons.filter((c) => {
    if (c.totalUsageLimit !== null && c.timesUsed >= c.totalUsageLimit) return false;
    if (!productId) return true;
    return c.products.length === 0 || c.products.some((p) => p.productId === productId);
  });

  res.json({
    data: visible.slice((page - 1) * limit, page * limit).map(toPublicCoupon),
    page,
    limit,
    total: visible.length,
  });
});

// Validate a coupon against the CALLER'S REAL cart (cookie / auth resolved).
// Returns the calculated discount and authoritative totals, or a typed
// error. Rate limited to prevent code enumeration.
couponRouter.post(
  '/validate',
  apiLimiter(10 * 60_000, 30),
  validate({ body: z.object({ code: z.string().min(2).max(40) }) }),
  async (req, res) => {
    const coupon = await findCouponByCode(req.body.code);
    if (!coupon) throw badRequest('That coupon code does not exist.');

    const cart = await getOrCreateCart(req);
    if (cart.items.length === 0) throw badRequest('Your bag is empty.');

    const shippingRule = await getShippingRule();
    const lines = cart.items.map((i) => ({
      variantId: i.variantId,
      productId: i.variant.productId,
      quantity: i.quantity,
      unitPricePaise: i.variant.pricePaise ?? i.variant.product.pricePaise,
    }));
    const subtotalPaise = lines.reduce((a, l) => a + l.unitPricePaise * l.quantity, 0);

    const evaluation = await evaluateCoupon(coupon.id, { items: lines }, { userId: req.user?.sub ?? null, email: '' }, shippingRule);
    if (!evaluation.ok) throw evaluationToApiError(evaluation);

    // Customer eligibility needs the email; guests only get order-history
    // based checks on their (not yet known) email, so skip for guests here -
    // it is enforced at order creation where the email is known.
    if (req.user?.sub) {
      const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
      if (user) {
        const ineligible = await checkCustomerEligibility(prisma, coupon, { userId: user.id, email: user.email });
        if (ineligible) throw evaluationToApiError(ineligible);
      }
    }

    const shipping = subtotalPaise >= shippingRule.freeShippingThresholdPaise ? 0 : shippingRule.flatShippingPaise;
    const totals = totalsWithCoupon({
      subtotalPaise,
      shippingPaise: shipping,
      taxPaise: 0,
      coupon: { code: evaluation.code, discountPaise: evaluation.discountPaise, freeShipping: evaluation.freeShipping },
    });

    res.json({
      data: {
        coupon: {
          code: evaluation.code,
          discountType: evaluation.discountType,
          description: evaluation.description,
          minimumOrderRupees: coupon.minimumOrderPaise ? Math.ceil(coupon.minimumOrderPaise / 100) : null,
          maximumDiscountRupees: coupon.maximumDiscountPaise ? Math.ceil(coupon.maximumDiscountPaise / 100) : null,
          expiresAt: coupon.expiresAt,
        },
        // Authoritative totals (rupees) for the checkout summary display.
        subtotal: paiseToRupees(totals.subtotalPaise),
        discount: paiseToRupees(totals.discountPaise),
        shipping: paiseToRupees(totals.shippingPaise),
        tax: paiseToRupees(totals.taxPaise),
        total: paiseToRupees(totals.totalPaise),
      },
    });
  },
);

const evaluationToApiError = (evaluation: { code: string; message: string }): ApiError =>
  new ApiError(400, evaluation.code, evaluation.message);
