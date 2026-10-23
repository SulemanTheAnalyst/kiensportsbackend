import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { apiLimiter } from '../../middleware/errorHandler';
import { optionalAuth } from '../../middleware/auth';
import { publicCouponShape, couponStatusBucket } from './coupon.service';


/**
 * Public coupon discovery. Returns ONLY coupons that are:
 *  - active and inside their validity window,
 *  - flagged isPublic (visible on the website),
 *  - not exhausted (active usages below the total limit, if any).
 *
 * The response contains safe display fields only - no internal names, usage
 * counters, per-customer rules or admin notes. Rate limited.
 */

export const couponRouter = Router();
couponRouter.use(optionalAuth, apiLimiter(60_000, 60));

couponRouter.get('/', async (req, res) => {
  const productSlug = typeof req.query.productSlug === 'string' ? req.query.productSlug.trim() : undefined;
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 6));
  const now = new Date();

  const where: Prisma.CouponWhereInput = {
    isActive: true,
    isPublic: true,
    OR: [{ startsAt: null }, { startsAt: { lte: now } }],
    AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] }],
  };

  const coupons = await prisma.coupon.findMany({
    where,
    include: { products: { select: { productId: true } }, },
    orderBy: [{ displayPriority: 'desc' }, { createdAt: 'desc' }],
    take: limit + 10, // small over-fetch; exhausted coupons filtered below
  });

  // Usage counts must consider only ACTIVE (non-released) usages.
  const ids = coupons.map((c) => c.id);
  const usageRows = ids.length
    ? await prisma.couponUsage.groupBy({ by: ['couponId'], where: { couponId: { in: ids }, status: 'ACTIVE' }, _count: { _all: true } })
    : [];
  const usageByCoupon = new Map(usageRows.map((r) => [r.couponId, r._count._all]));

  const visible = coupons
    .filter((c) => {
      const used = usageByCoupon.get(c.id) ?? 0;
      if (c.totalUsageLimit !== null && used >= c.totalUsageLimit) return false;
      return couponStatusBucket(c) === 'ACTIVE';
    })
    .slice(0, limit);

  let productFilterId: string | null = null;
  if (productSlug) {
    const product = await prisma.product.findUnique({ where: { slug: productSlug }, select: { id: true } });
    productFilterId = product?.id ?? null;
  }

  const data = visible.map((c) => {
    const eligibleIds = new Set(c.products.map((p) => p.productId));
    // When filtering for a product page, keep only coupons that apply to it.
    if (productFilterId !== null && eligibleIds.size > 0 && !eligibleIds.has(productFilterId)) return null;
    return publicCouponShape(c, eligibleIds);
  });

  res.json({ data: data.filter(Boolean) });
});
