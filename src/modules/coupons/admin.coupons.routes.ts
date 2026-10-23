import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { notFound, badRequest } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';
import { audit } from '../../lib/audit';
import { normalizeCouponCode, couponStatusBucket, assertDiscountShape } from '../coupons/coupon.service';

/**
 * Admin coupon management. Every route requires the ADMIN role (enforced
 * server-side); every mutation is audit-logged. Codes are normalised to
 * UPPERCASE and duplicates are prevented by the database unique constraint.
 */

const couponBodySchema = z
  .object({
    code: z.string().trim().min(3).max(24).regex(/^[A-Za-z0-9_-]+$/, 'Letters, numbers, - and _ only'),
    internalName: z.string().trim().min(1).max(120),
    publicDescription: z.string().trim().max(300).optional().nullable(),
    discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT', 'FREE_SHIPPING']),
    // percent points for PERCENTAGE, RUPEES for FIXED_AMOUNT (converted below)
    discountValue: z.number().int().min(0).max(1000000),
    minimumOrderRupees: z.number().int().min(0).max(10000000).optional(),
    maximumDiscountRupees: z.number().int().min(1).max(10000000).optional().nullable(),
    startsAt: z.string().datetime({ offset: true }).optional().nullable(),
    expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
    isActive: z.boolean().optional(),
    isPublic: z.boolean().optional(),
    promotionalHeadline: z.string().trim().max(120).optional().nullable(),
    campaignBadge: z.string().trim().max(24).optional().nullable(),
    displayPriority: z.number().int().min(0).max(1000).optional(),
    totalUsageLimit: z.number().int().min(1).max(1000000).optional().nullable(),
    perCustomerUsageLimit: z.number().int().min(1).max(1000).optional().nullable(),
    firstOrderOnly: z.boolean().optional(),
    productIds: z.array(z.string()).max(200).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.discountType === 'PERCENTAGE' && v.discountValue > 100) {
      ctx.addIssue({ code: 'custom', path: ['discountValue'], message: 'Percentage must be between 1 and 100' });
    }
    if (v.discountType === 'FIXED_AMOUNT' && v.discountValue < 1) {
      ctx.addIssue({ code: 'custom', path: ['discountValue'], message: 'Fixed discount must be at least ₹1' });
    }
  });

const rupeesToPaise = (r: number) => r * 100;

const statusFilter = (status: string | undefined, now = new Date()): Prisma.CouponWhereInput => {
  switch (status) {
    case 'active':
      return { isActive: true, OR: [{ startsAt: null }, { startsAt: { lte: now } }], AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] }] };
    case 'scheduled':
      return { isActive: true, startsAt: { gt: now } };
    case 'expired':
      return { expiresAt: { lt: now } };
    case 'disabled':
      return { isActive: false };
    default:
      return {};
  }
};

const couponInclude = {
  products: { select: { productId: true } },
  usages: { select: { status: true } },
} satisfies Prisma.CouponInclude;

type AdminCouponRow = Prisma.CouponGetPayload<{ include: typeof couponInclude }>;

const toAdminCoupon = (c: AdminCouponRow) => {
  const activeUsages = c.usages.filter((u) => u.status === 'ACTIVE').length;
  return {
    id: c.id,
    code: c.code,
    internalName: c.internalName,
    publicDescription: c.publicDescription,
    discountType: c.discountType,
    // PERCENTAGE: percent points; FIXED_AMOUNT: rupees (paise / 100)
    discountValue: c.discountType === 'FIXED_AMOUNT' ? c.discountValue / 100 : c.discountValue,
    minimumOrderRupees: c.minimumOrderPaise > 0 ? c.minimumOrderPaise / 100 : 0,
    maximumDiscountRupees: c.maximumDiscountPaise ? c.maximumDiscountPaise / 100 : null,
    startsAt: c.startsAt,
    expiresAt: c.expiresAt,
    isActive: c.isActive,
    isPublic: c.isPublic,
    promotionalHeadline: c.promotionalHeadline,
    campaignBadge: c.campaignBadge,
    displayPriority: c.displayPriority,
    totalUsageLimit: c.totalUsageLimit,
    perCustomerUsageLimit: c.perCustomerUsageLimit,
    firstOrderOnly: c.firstOrderOnly,
    productIds: c.products?.map((p) => p.productId) ?? [],
    usageCount: activeUsages,
    status: couponStatusBucket(c),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
};

export const adminCouponsRouter = Router();
adminCouponsRouter.use(requireAuth, requireRole('ADMIN'));

// ---------------- Listing ----------------

adminCouponsRouter.get('/coupons', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 25));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'newest';

  const where: Prisma.CouponWhereInput = {
    ...statusFilter(status),
    ...(search ? { code: { contains: normalizeCouponCode(search), mode: 'insensitive' } } : {}),
  };

  const orderBy: Prisma.CouponOrderByWithRelationInput =
    sort === 'code' ? { code: 'asc' } : sort === 'expiry' ? { expiresAt: 'asc' } : sort === 'usage' ? { usages: { _count: 'desc' } } : { createdAt: 'desc' };

  const [items, total] = await Promise.all([
    prisma.coupon.findMany({ where, include: couponInclude, orderBy, skip: (page - 1) * limit, take: limit }),
    prisma.coupon.count({ where }),
  ]);
  res.json({ data: items.map(toAdminCoupon), page, limit, total });
});

// ---------------- Create ----------------

adminCouponsRouter.post(
  '/coupons',
  validate({ body: couponBodySchema }),
  async (req, res) => {
    const b = req.body as z.infer<typeof couponBodySchema>;
    const code = normalizeCouponCode(b.code);
    assertDiscountShape(b.discountType, b.discountValue);

    const created = await prisma.$transaction(async (tx) => {
      const existing = await tx.coupon.findUnique({ where: { code } });
      if (existing) throw badRequest('A coupon with code ' + code + ' already exists.');
      return tx.coupon.create({
        data: {
          code,
          internalName: b.internalName,
          publicDescription: b.publicDescription ?? null,
          discountType: b.discountType,
          // FIXED_AMOUNT arrives in rupees and is stored as paise.
          discountValue: b.discountType === 'FIXED_AMOUNT' ? rupeesToPaise(b.discountValue) : b.discountValue,
          minimumOrderPaise: rupeesToPaise(b.minimumOrderRupees ?? 0),
          maximumDiscountPaise:
            b.discountType === 'PERCENTAGE' && b.maximumDiscountRupees ? rupeesToPaise(b.maximumDiscountRupees) : null,
          startsAt: b.startsAt ? new Date(b.startsAt) : null,
          expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
          isActive: b.isActive ?? true,
          isPublic: b.isPublic ?? false,
          promotionalHeadline: b.promotionalHeadline ?? null,
          campaignBadge: b.campaignBadge ?? null,
          displayPriority: b.displayPriority ?? 0,
          totalUsageLimit: b.totalUsageLimit ?? null,
          perCustomerUsageLimit: b.perCustomerUsageLimit ?? null,
          firstOrderOnly: b.firstOrderOnly ?? false,
          ...(b.productIds && b.productIds.length > 0
            ? { products: { create: b.productIds.map((productId) => ({ productId })) } }
            : {}),
        },
        include: couponInclude,
      });
    });
    await audit(req.user!.sub, 'COUPON_CREATED', 'Coupon', created.id, { code, discountType: b.discountType }, req.ip);
    res.status(201).json({ data: toAdminCoupon(created) });
  },
);

// ---------------- Detail ----------------

adminCouponsRouter.get('/coupons/:id', async (req, res) => {
  const coupon = await prisma.coupon.findUnique({
    where: { id: String(req.params.id) },
    include: { ...couponInclude, products: { include: { product: { select: { id: true, name: true, slug: true } } } } },
  });
  if (!coupon) throw notFound('Coupon not found');
  const shaped = toAdminCoupon(coupon);
  res.json({ data: { ...shaped, products: coupon.products.map((p) => p.product) } });
});

// ---------------- Update ----------------

adminCouponsRouter.patch(
  '/coupons/:id',
  validate({ body: couponBodySchema.partial() }),
  async (req, res) => {
    const id = String(req.params.id);
    const b = req.body as Partial<z.infer<typeof couponBodySchema>>;
    const existing = await prisma.coupon.findUnique({ where: { id }, include: couponInclude });
    if (!existing) throw notFound('Coupon not found');
    if (b.discountType) assertDiscountShape(b.discountType, b.discountValue ?? existing.discountValue);

    // Code changes keep the same normalisation + uniqueness guarantees.
    let newCode: string | undefined;
    if (b.code !== undefined) {
      newCode = normalizeCouponCode(b.code);
      if (newCode !== existing.code) {
        const clash = await prisma.coupon.findUnique({ where: { code: newCode } });
        if (clash) throw badRequest('A coupon with code ' + newCode + ' already exists.');
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const coupon = await tx.coupon.update({
        where: { id },
        data: {
          ...(newCode !== undefined ? { code: newCode } : {}),
          ...(b.internalName !== undefined ? { internalName: b.internalName } : {}),
          ...(b.publicDescription !== undefined ? { publicDescription: b.publicDescription } : {}),
          ...(b.discountType !== undefined ? { discountType: b.discountType } : {}),
          ...(b.discountValue !== undefined
            ? {
                discountValue:
                  (b.discountType ?? existing.discountType) === 'FIXED_AMOUNT' ? rupeesToPaise(b.discountValue) : b.discountValue,
              }
            : {}),
          ...(b.minimumOrderRupees !== undefined ? { minimumOrderPaise: rupeesToPaise(b.minimumOrderRupees) } : {}),
          ...(b.maximumDiscountRupees !== undefined
            ? { maximumDiscountPaise: b.maximumDiscountRupees ? rupeesToPaise(b.maximumDiscountRupees) : null }
            : {}),
          ...(b.startsAt !== undefined ? { startsAt: b.startsAt ? new Date(b.startsAt) : null } : {}),
          ...(b.expiresAt !== undefined ? { expiresAt: b.expiresAt ? new Date(b.expiresAt) : null } : {}),
          ...(b.isActive !== undefined ? { isActive: b.isActive } : {}),
          ...(b.isPublic !== undefined ? { isPublic: b.isPublic } : {}),
          ...(b.promotionalHeadline !== undefined ? { promotionalHeadline: b.promotionalHeadline } : {}),
          ...(b.campaignBadge !== undefined ? { campaignBadge: b.campaignBadge } : {}),
          ...(b.displayPriority !== undefined ? { displayPriority: b.displayPriority } : {}),
          ...(b.totalUsageLimit !== undefined ? { totalUsageLimit: b.totalUsageLimit ?? null } : {}),
          ...(b.perCustomerUsageLimit !== undefined ? { perCustomerUsageLimit: b.perCustomerUsageLimit ?? null } : {}),
          ...(b.firstOrderOnly !== undefined ? { firstOrderOnly: b.firstOrderOnly } : {}),
        },
        include: couponInclude,
      });
      // Product restrictions are replaced wholesale (simple, predictable).
      if (b.productIds !== undefined) {
        await tx.couponProduct.deleteMany({ where: { couponId: id } });
        if (b.productIds.length > 0) {
          await tx.couponProduct.createMany({ data: b.productIds.map((productId) => ({ couponId: id, productId })) });
        }
      }
      return tx.coupon.findUniqueOrThrow({ where: { id }, include: couponInclude });
    });
    await audit(req.user!.sub, 'COUPON_UPDATED', 'Coupon', id, { fields: Object.keys(b) }, req.ip);
    res.json({ data: toAdminCoupon(updated) });
  },
);

// ---------------- Enable / disable ----------------

adminCouponsRouter.post('/coupons/:id/toggle', async (req, res) => {
  const id = String(req.params.id);
  const existing = await prisma.coupon.findUnique({ where: { id } });
  if (!existing) throw notFound('Coupon not found');
  const updated = await prisma.coupon.update({
    where: { id },
    data: { isActive: !existing.isActive },
    include: couponInclude,
  });
  await audit(req.user!.sub, updated.isActive ? 'COUPON_ENABLED' : 'COUPON_DISABLED', 'Coupon', id, {}, req.ip);
  res.json({ data: toAdminCoupon(updated) });
});

// ---------------- Usage history + performance ----------------

adminCouponsRouter.get('/coupons/:id/usage', async (req, res) => {
  const id = String(req.params.id);
  const coupon = await prisma.coupon.findUnique({ where: { id } });
  if (!coupon) throw notFound('Coupon not found');
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const [items, total] = await Promise.all([
    prisma.couponUsage.findMany({
      where: { couponId: id },
      include: { order: { select: { orderNumber: true, status: true, paymentStatus: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.couponUsage.count({ where: { couponId: id } }),
  ]);
  const [activeCount, releasedCount, discountAgg] = await Promise.all([
    prisma.couponUsage.count({ where: { couponId: id, status: 'ACTIVE' } }),
    prisma.couponUsage.count({ where: { couponId: id, status: 'RELEASED' } }),
    prisma.couponUsage.aggregate({
      where: { couponId: id, status: 'ACTIVE' },
      _sum: { discountPaise: true },
    }),
  ]);
  res.json({
    data: items.map((u) => ({
      id: u.id,
      orderId: u.orderId,
      orderNumber: u.order.orderNumber,
      orderStatus: u.order.status,
      orderPaymentStatus: u.order.paymentStatus,
      email: u.email,
      userId: u.userId,
      discountRupees: u.discountPaise / 100,
      status: u.status,
      releaseReason: u.releaseReason,
      createdAt: u.createdAt,
      releasedAt: u.releasedAt,
    })),
    summary: {
      activeUsages: activeCount,
      releasedUsages: releasedCount,
      totalDiscountRupees: discountAgg._sum.discountPaise ? discountAgg._sum.discountPaise / 100 : 0,
    },
    page,
    limit,
    total,
  });
});
