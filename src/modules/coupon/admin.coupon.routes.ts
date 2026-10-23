import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { validate } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { paiseToRupees, rupeesToPaise } from '../../lib/money';
import { audit } from '../../lib/audit';
import { normalizeCode } from './coupon.service';

// Admin coupon management. Every route requires the ADMIN role (enforced
// server-side below) and every mutation is audit-logged. Codes are
// normalised to uppercase + trimmed; duplicates are rejected with 409
// (database uniqueness constraint is the final guard).

export const adminCouponRouter = Router();
adminCouponRouter.use(requireAuth, requireRole('ADMIN'));

const discountBody = z
  .object({
    discountType: z.enum(['PERCENT', 'FIXED', 'FREE_SHIPPING']),
    // rupees for FIXED, whole percent for PERCENT (public API speaks rupees)
    discountValue: z.number().int().min(0).max(100000),
  })
  .superRefine((v, ctx) => {
    if (v.discountType === 'PERCENT' && (v.discountValue < 1 || v.discountValue > 90)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Percentage discounts must be between 1 and 90' });
    }
  });

const couponCreateSchema = z.object({
  code: z.string().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/, 'Letters, numbers, - and _ only'),
  internalName: z.string().min(2).max(120),
  publicDescription: z.string().max(500).optional().nullable(),
  discount: discountBody,
  minimumOrderRupees: z.number().int().min(0).default(0),
  maximumDiscountRupees: z.number().int().min(0).optional().nullable(),
  startsAt: z.coerce.date(),
  expiresAt: z.coerce.date().optional().nullable(),
  isActive: z.boolean().default(true),
  isPublic: z.boolean().default(false),
  displayPriority: z.number().int().min(0).max(1000).default(0),
  promoHeadline: z.string().max(120).optional().nullable(),
  totalUsageLimit: z.number().int().min(1).optional().nullable(),
  perCustomerUsageLimit: z.number().int().min(1).optional().nullable(),
  firstOrderOnly: z.boolean().default(false),
  productIds: z.array(z.string().min(10).max(40)).max(100).default([]),
});

const couponUpdateSchema = couponCreateSchema.partial().omit({ code: true });

const toAdminCoupon = (
  c: Prisma.CouponGetPayload<{ include: { products: { select: { productId: true; product: { select: { name: true; slug: true } } } } } }>,
) => ({
  id: c.id,
  code: c.code,
  internalName: c.internalName,
  publicDescription: c.publicDescription,
  discountType: c.discountType,
  discountValue: c.discountType === 'PERCENT' ? c.discountValue : paiseToRupees(c.discountValue),
  minimumOrderRupees: paiseToRupees(c.minimumOrderPaise),
  maximumDiscountRupees: c.maximumDiscountPaise ? paiseToRupees(c.maximumDiscountPaise) : null,
  startsAt: c.startsAt,
  expiresAt: c.expiresAt,
  isActive: c.isActive,
  isPublic: c.isPublic,
  displayPriority: c.displayPriority,
  promoHeadline: c.promoHeadline,
  totalUsageLimit: c.totalUsageLimit,
  perCustomerUsageLimit: c.perCustomerUsageLimit,
  firstOrderOnly: c.firstOrderOnly,
  timesUsed: c.timesUsed,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  products: c.products.map((p) => ({ productId: p.productId, name: p.product.name, slug: p.product.slug })),
});

const couponStatus = (c: { isActive: boolean; startsAt: Date; expiresAt: Date | null }) => {
  const now = new Date();
  if (!c.isActive) return 'DISABLED';
  if (c.startsAt > now) return 'SCHEDULED';
  if (c.expiresAt && c.expiresAt <= now) return 'EXPIRED';
  return 'ACTIVE';
};

adminCouponRouter.get('/', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 25));
  const search = typeof req.query.search === 'string' ? req.query.search.trim().toUpperCase() : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'createdAt';

  const where: Prisma.CouponWhereInput = {
    ...(search ? { OR: [{ code: { contains: search } }, { internalName: { contains: search, mode: 'insensitive' } }] } : {}),
  };
  const now = new Date();
  if (status === 'ACTIVE') {
    Object.assign(where, { isActive: true, startsAt: { lte: now }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });
  } else if (status === 'SCHEDULED') {
    Object.assign(where, { isActive: true, startsAt: { gt: now } });
  } else if (status === 'EXPIRED') {
    Object.assign(where, { expiresAt: { lte: now } });
  } else if (status === 'DISABLED') {
    Object.assign(where, { isActive: false });
  }

  const orderBy: Prisma.CouponOrderByWithRelationInput =
    sort === 'code' ? { code: 'asc' } : sort === 'usage' ? { timesUsed: 'desc' } : sort === 'expiresAt' ? { expiresAt: 'asc' } : { createdAt: 'desc' };

  const [items, total] = await Promise.all([
    prisma.coupon.findMany({
      where,
      include: { products: { include: { product: { select: { name: true, slug: true } } } } },
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.coupon.count({ where }),
  ]);
  res.json({
    data: items.map((c) => ({ ...toAdminCoupon(c), status: couponStatus(c) })),
    page,
    limit,
    total,
  });
});

adminCouponRouter.post('/', validate({ body: couponCreateSchema }), async (req, res) => {
  const body = req.body as z.infer<typeof couponCreateSchema>;
  const code = normalizeCode(body.code);
  if (!code) throw badRequest('Coupon code required');

  const existing = await prisma.coupon.findUnique({ where: { code } });
  if (existing) throw conflict('COUPON_DUPLICATE', 'A coupon with code ' + code + ' already exists');

  if (body.productIds.length > 0) {
    const products = await prisma.product.findMany({ where: { id: { in: body.productIds } }, select: { id: true } });
    if (products.length !== new Set(body.productIds).size) throw badRequest('Unknown product id in productIds');
  }
  if (body.expiresAt && new Date(body.expiresAt) <= new Date(body.startsAt)) {
    throw badRequest('Expiry must be after the start date');
  }

  const coupon = await prisma.coupon.create({
    data: {
      code,
      internalName: body.internalName,
      publicDescription: body.publicDescription ?? null,
      discountType: body.discount.discountType,
      discountValue:
        body.discount.discountType === 'PERCENT'
          ? body.discount.discountValue
          : body.discount.discountType === 'FIXED'
            ? rupeesToPaise(body.discount.discountValue)
            : 0,
      minimumOrderPaise: rupeesToPaise(body.minimumOrderRupees),
      maximumDiscountPaise: body.maximumDiscountRupees ? rupeesToPaise(body.maximumDiscountRupees) : null,
      startsAt: body.startsAt,
      expiresAt: body.expiresAt ?? null,
      isActive: body.isActive,
      isPublic: body.isPublic,
      displayPriority: body.displayPriority,
      promoHeadline: body.promoHeadline ?? null,
      totalUsageLimit: body.totalUsageLimit ?? null,
      perCustomerUsageLimit: body.perCustomerUsageLimit ?? null,
      firstOrderOnly: body.firstOrderOnly,
      products: body.productIds.length ? { create: body.productIds.map((productId) => ({ productId })) } : undefined,
    },
  });
  await audit(req.user!.sub, 'COUPON_CREATED', 'Coupon', coupon.id, { code, discountType: body.discount.discountType }, req.ip);
  res.status(201).json({ data: { id: coupon.id, code: coupon.code } });
});

adminCouponRouter.get('/:id', async (req, res) => {
  const coupon = await prisma.coupon.findUnique({
    where: { id: String(req.params.id) },
    include: { products: { include: { product: { select: { name: true, slug: true } } } } },
  });
  if (!coupon) throw notFound('Coupon not found');
  res.json({ data: { ...toAdminCoupon(coupon), status: couponStatus(coupon) } });
});

adminCouponRouter.patch('/:id', validate({ params: z.object({ id: z.string().min(10).max(40) }), body: couponUpdateSchema }), async (req, res) => {
  const id = String(req.params.id);
  const body = req.body as z.infer<typeof couponUpdateSchema>;
  const existing = await prisma.coupon.findUnique({ where: { id }, include: { products: true } });
  if (!existing) throw notFound('Coupon not found');

  if (body.productIds) {
    const products = await prisma.product.findMany({ where: { id: { in: body.productIds } }, select: { id: true } });
    if (products.length !== new Set(body.productIds).size) throw badRequest('Unknown product id in productIds');
  }
  const startsAt = body.startsAt ?? existing.startsAt;
  const expiresAt = body.expiresAt === undefined ? existing.expiresAt : body.expiresAt;
  if (expiresAt && new Date(expiresAt) <= new Date(startsAt)) throw badRequest('Expiry must be after the start date');

  const data: Prisma.CouponUpdateInput = {
    internalName: body.internalName,
    publicDescription: body.publicDescription,
    maximumDiscountPaise: body.maximumDiscountRupees === undefined ? undefined : body.maximumDiscountRupees ? rupeesToPaise(body.maximumDiscountRupees) : null,
    startsAt: body.startsAt,
    expiresAt: body.expiresAt === undefined ? undefined : body.expiresAt,
    isActive: body.isActive,
    isPublic: body.isPublic,
    displayPriority: body.displayPriority,
    promoHeadline: body.promoHeadline,
    totalUsageLimit: body.totalUsageLimit,
    perCustomerUsageLimit: body.perCustomerUsageLimit,
    firstOrderOnly: body.firstOrderOnly,
    minimumOrderPaise: body.minimumOrderRupees === undefined ? undefined : rupeesToPaise(body.minimumOrderRupees),
  };
  if (body.discount) {
    data.discountType = body.discount.discountType;
    data.discountValue =
      body.discount.discountType === 'PERCENT'
        ? body.discount.discountValue
        : body.discount.discountType === 'FIXED'
          ? rupeesToPaise(body.discount.discountValue)
          : 0;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const c = await tx.coupon.update({ where: { id }, data });
    if (body.productIds) {
      await tx.couponProduct.deleteMany({ where: { couponId: id } });
      if (body.productIds.length > 0) {
        await tx.couponProduct.createMany({ data: body.productIds.map((productId) => ({ couponId: id, productId })) });
      }
    }
    return c;
  });
  await audit(req.user!.sub, 'COUPON_UPDATED', 'Coupon', id, body, req.ip);
  res.json({ data: { id: updated.id, code: updated.code } });
});

const setActivation = (activate: boolean) => async (req: { params: { id: string }; user?: { sub: string }; ip?: string }, res: any) => {
  const id = String(req.params.id);
  const coupon = await prisma.coupon.findUnique({ where: { id } });
  if (!coupon) throw notFound('Coupon not found');
  const updated = await prisma.coupon.update({ where: { id }, data: { isActive: activate } });
  await audit(req.user!.sub, activate ? 'COUPON_ENABLED' : 'COUPON_DISABLED', 'Coupon', id, { code: coupon.code }, req.ip);
  res.json({ data: { id: updated.id, code: updated.code, isActive: updated.isActive } });
};

adminCouponRouter.post('/:id/enable', validate({ params: z.object({ id: z.string().min(10).max(40) }) }), setActivation(true));
adminCouponRouter.post('/:id/disable', validate({ params: z.object({ id: z.string().min(10).max(40) }) }), setActivation(false));

// Usage history: every redemption (active + released) with its outcome.
adminCouponRouter.get('/:id/usage', async (req, res) => {
  const coupon = await prisma.coupon.findUnique({ where: { id: String(req.params.id) } });
  if (!coupon) throw notFound('Coupon not found');
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 25));
  const [rows, total] = await Promise.all([
    prisma.couponRedemption.findMany({
      where: { couponId: coupon.id },
      include: { order: { select: { orderNumber: true, status: true, paymentStatus: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.couponRedemption.count({ where: { couponId: coupon.id } }),
  ]);
  res.json({
    data: rows.map((r) => ({
      id: r.id,
      orderNumber: r.order.orderNumber,
      orderStatus: r.order.status,
      paymentStatus: r.order.paymentStatus,
      email: r.email,
      discountRupees: paiseToRupees(r.discountPaise),
      createdAt: r.createdAt,
      releasedAt: r.releasedAt,
      releasedReason: r.releasedReason,
      status: r.releasedAt ? 'RELEASED' : 'REDEEMED',
    })),
    page,
    limit,
    total,
  });
});

// Performance report for one coupon.
adminCouponRouter.get('/:id/report', async (req, res) => {
  const coupon = await prisma.coupon.findUnique({ where: { id: String(req.params.id) } });
  if (!coupon) throw notFound('Coupon not found');
  const [redemptions, active, released, discountAgg, orderAgg] = await Promise.all([
    prisma.couponRedemption.count({ where: { couponId: coupon.id } }),
    prisma.couponRedemption.count({ where: { couponId: coupon.id, releasedAt: null } }),
    prisma.couponRedemption.count({ where: { couponId: coupon.id, releasedAt: { not: null } } }),
    prisma.couponRedemption.aggregate({ where: { couponId: coupon.id, releasedAt: null }, _sum: { discountPaise: true } }),
    prisma.order.aggregate({
      where: { couponId: coupon.id, paymentStatus: 'PAID', status: { not: 'CANCELLED' } },
      _sum: { totalPaise: true },
      _count: { _all: true },
    }),
  ]);
  res.json({
    data: {
      code: coupon.code,
      totalRedemptions: redemptions,
      activeRedemptions: active,
      releasedRedemptions: released,
      totalDiscountGivenRupees: paiseToRupees(discountAgg._sum.discountPaise ?? 0),
      paidOrders: orderAgg._count._all,
      revenueFromPaidOrdersRupees: paiseToRupees(orderAgg._sum.totalPaise ?? 0),
    },
  });
});
