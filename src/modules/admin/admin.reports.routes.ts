import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { notFound } from '../../lib/errors';
import { requireAuth, requireRole } from '../../middleware/auth';

/**
 * Admin read-side / analytics endpoints.
 *
 * All routes require the ADMIN role (enforced server-side below, independent
 * of any frontend route guard).
 *
 * Financial metric definitions (documented contract for the admin dashboard):
 * - grossSales   : sum of Order.totalPaise for orders with paymentStatus = PAID
 *                  and status NOT IN (CANCELLED). Pending/failed payments,
 *                  COD_PENDING and cancelled orders are excluded.
 * - refundsTotal : sum of Refund.amountPaise where Refund.status = PROCESSED.
 * - netSales     : grossSales - refundsTotal.
 * - Sales-by-day uses only PAID non-cancelled orders from the last 30 days.
 *   Orders are fetched as (createdAt, totalPaise) pairs and aggregated in a
 *   single pass (bounded to a 30-day window; revisit with a SQL rollup when
 *   daily volume makes this large).
 */
export const adminReportsRouter = Router();
adminReportsRouter.use(requireAuth, requireRole('ADMIN'));

const paiseToRupees = (p: number) => Math.round(p) / 100;

const pageParams = (req: { query: Record<string, unknown> }, maxLimit = 60, defLimit = 25) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number(req.query.limit) || defLimit));
  return { page, limit, skip: (page - 1) * limit };
};

// ---------------- Dashboard summary ----------------

adminReportsRouter.get('/dashboard/summary', async (_req, res) => {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  since.setHours(0, 0, 0, 0);

  const [
    totalOrders,
    ordersByStatusRows,
    totalProducts,
    activeProducts,
    totalCustomers,
    paidOrdersAgg,
    refundsAgg,
    lowStock,
    recentOrders,
    bestSellerRows,
    salesRows,
  ] = await Promise.all([
    prisma.order.count(),
    prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.product.count(),
    prisma.product.count({ where: { status: 'ACTIVE' } }),
    prisma.user.count(),
    prisma.order.aggregate({
      where: { paymentStatus: 'PAID', status: { not: 'CANCELLED' } },
      _sum: { totalPaise: true },
      _count: { _all: true },
    }),
    prisma.refund.aggregate({ where: { status: 'PROCESSED' }, _sum: { amountPaise: true } }),
    prisma.inventory.findMany({
      where: { availableQty: { lte: prisma.inventory.fields.lowStockThreshold } },
      include: { variant: { include: { product: { select: { name: true, slug: true } } } } },
      orderBy: { availableQty: 'asc' },
      take: 10,
    }),
    prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        orderNumber: true, email: true, status: true, paymentStatus: true,
        totalPaise: true, createdAt: true,
      },
    }),
    prisma.orderItem.groupBy({
      by: ['variantId'],
      where: {
        variantId: { not: null },
        order: { paymentStatus: 'PAID', status: { not: 'CANCELLED' } },
      },
      _sum: { quantity: true, lineTotalPaise: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: 5,
    }),
    prisma.order.findMany({
      where: {
        paymentStatus: 'PAID',
        status: { not: 'CANCELLED' },
        createdAt: { gte: since },
      },
      select: { createdAt: true, totalPaise: true },
    }),
  ]);

  // Resolve best sellers to product names.
  const variantIds = bestSellerRows.map((r) => r.variantId).filter((v): v is string => v !== null);
  const variants = await prisma.productVariant.findMany({
    where: { id: { in: variantIds } },
    include: { product: { select: { name: true, slug: true } } },
  });
  const variantById = new Map(variants.map((v) => [v.id, v]));

  const grossSalesPaise = paidOrdersAgg._sum.totalPaise ?? 0;
  const refundsPaise = refundsAgg._sum.amountPaise ?? 0;

  const byDay = new Map<string, { date: string; orders: number; revenuePaise: number }>();
  for (const o of salesRows) {
    const date = o.createdAt.toISOString().slice(0, 10);
    const entry = byDay.get(date) ?? { date, orders: 0, revenuePaise: 0 };
    entry.orders += 1;
    entry.revenuePaise += o.totalPaise;
    byDay.set(date, entry);
  }

  const ordersByStatus: Record<string, number> = {};
  let pendingFulfilment = 0;
  for (const row of ordersByStatusRows) {
    ordersByStatus[row.status] = row._count._all;
    if (row.status === 'CONFIRMED' || row.status === 'PROCESSING') pendingFulfilment += row._count._all;
  }

  res.json({
    data: {
      orders: {
        total: totalOrders,
        byStatus: ordersByStatus,
        pendingFulfilment,
      },
      products: {
        total: totalProducts,
        active: activeProducts,
        lowStockCount: lowStock.length,
      },
      customers: { total: totalCustomers },
      sales: {
        // rupee amounts (integer paise converted at the API boundary)
        grossSales: paiseToRupees(grossSalesPaise),
        refundsTotal: paiseToRupees(refundsPaise),
        netSales: paiseToRupees(grossSalesPaise - refundsPaise),
        paidOrders: paidOrdersAgg._count._all,
      },
      recentOrders: recentOrders.map((o) => ({
        orderNumber: o.orderNumber,
        email: o.email,
        status: o.status,
        paymentStatus: o.paymentStatus,
        total: paiseToRupees(o.totalPaise),
        createdAt: o.createdAt,
      })),
      bestSellers: bestSellerRows.map((r) => {
        const v = r.variantId ? variantById.get(r.variantId) : undefined;
        return {
          productId: v?.productId ?? null,
          productName: v?.product.name ?? 'Unknown product',
          productSlug: v?.product.slug ?? null,
          sku: v?.sku ?? null,
          unitsSold: r._sum.quantity ?? 0,
          revenue: paiseToRupees(r._sum.lineTotalPaise ?? 0),
        };
      }),
      salesByDay: Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({
        date: d.date,
        orders: d.orders,
        revenue: paiseToRupees(d.revenuePaise),
      })),
      lowStockItems: lowStock.map((i) => ({
        sku: i.variant.sku,
        product: i.variant.product.name,
        availableQty: i.availableQty,
        threshold: i.lowStockThreshold,
      })),
    },
  });
});

// ---------------- Order detail ----------------

adminReportsRouter.get('/orders/:orderNumber', async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { orderNumber: String(req.params.orderNumber) },
    include: {
      items: true,
      payments: true,
      shipments: true,
      statusEvents: { orderBy: { createdAt: 'desc' } },
      returnRequests: { include: { refunds: true } },
      user: { select: { id: true, email: true, firstName: true, lastName: true } },
    },
  });
  if (!order) throw notFound('Order not found');
  res.json({ data: order });
});

// ---------------- Customers ----------------

adminReportsRouter.get('/customers', async (req, res) => {
  const { page, limit, skip } = pageParams(req as never);
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
  const where: Prisma.UserWhereInput = search
    ? {
        OR: [
          { email: { contains: search, mode: 'insensitive' } },
          { firstName: { contains: search, mode: 'insensitive' } },
          { lastName: { contains: search, mode: 'insensitive' } },
        ],
      }
    : {};

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      // Explicitly excludes passwordHash and all credential material.
      select: {
        id: true, email: true, firstName: true, lastName: true, phone: true,
        emailVerifiedAt: true, isActive: true, createdAt: true,
        roles: { include: { role: { select: { name: true } } } },
        _count: { select: { orders: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.user.count({ where }),
  ]);

  // Purchase totals from PAID, non-cancelled orders only, for this page.
  const ids = users.map((u) => u.id);
  const orderAgg = await prisma.order.groupBy({
    by: ['userId'],
    where: {
      userId: { in: ids },
      paymentStatus: 'PAID',
      status: { not: 'CANCELLED' },
    },
    _sum: { totalPaise: true },
    _count: { _all: true },
  });
  const aggById = new Map(orderAgg.map((a) => [a.userId, a]));

  res.json({
    data: users.map((u) => {
      const agg = aggById.get(u.id);
      return {
        id: u.id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        phone: u.phone,
        emailVerified: !!u.emailVerifiedAt,
        isActive: u.isActive,
        roles: u.roles.map((r) => r.role.name),
        totalOrders: u._count.orders,
        paidOrders: agg?._count._all ?? 0,
        lifetimeValue: paiseToRupees(agg?._sum.totalPaise ?? 0),
        createdAt: u.createdAt,
      };
    }),
    page,
    limit,
    total,
  });
});

adminReportsRouter.get('/customers/:id', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: String(req.params.id) },
    select: {
      id: true, email: true, firstName: true, lastName: true, phone: true,
      emailVerifiedAt: true, isActive: true, createdAt: true,
      roles: { include: { role: { select: { name: true } } } },
      addresses: true,
      orders: {
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          orderNumber: true, status: true, paymentStatus: true,
          totalPaise: true, createdAt: true,
        },
      },
    },
  });
  if (!user) throw notFound('Customer not found');
  res.json({
    data: {
      ...user,
      emailVerified: !!user.emailVerifiedAt,
      roles: user.roles.map((r) => r.role.name),
      orders: user.orders.map((o) => ({
        orderNumber: o.orderNumber,
        status: o.status,
        paymentStatus: o.paymentStatus,
        total: paiseToRupees(o.totalPaise),
        createdAt: o.createdAt,
      })),
    },
  });
});

// ---------------- Payments ----------------

adminReportsRouter.get('/payments', async (req, res) => {
  const { page, limit, skip } = pageParams(req);
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const where: Prisma.PaymentWhereInput = status ? { status } : {};
  const [items, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: { order: { select: { orderNumber: true, email: true, paymentStatus: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.payment.count({ where }),
  ]);
  res.json({
    data: items.map((p) => ({
      id: p.id,
      orderId: p.orderId,
      orderNumber: p.order.orderNumber,
      orderEmail: p.order.email,
      provider: p.provider,
      // Provider transaction ids are operational references (safe to show to
      // admins); no secrets are included.
      providerOrderId: p.providerOrderId,
      providerPaymentId: p.providerPaymentId,
      method: p.method,
      amount: paiseToRupees(p.amountPaise),
      status: p.status,
      webhookVerifiedAt: p.webhookVerifiedAt,
      createdAt: p.createdAt,
    })),
    page,
    limit,
    total,
  });
});

// ---------------- Shipments ----------------

adminReportsRouter.get('/shipments', async (req, res) => {
  const { page, limit, skip } = pageParams(req);
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const where = status ? { status } : {};
  const [items, total] = await Promise.all([
    prisma.shipment.findMany({
      where,
      include: { order: { select: { orderNumber: true, email: true, status: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.shipment.count({ where }),
  ]);
  res.json({ data: items, page, limit, total });
});

// ---------------- Inventory ----------------

adminReportsRouter.get('/inventory', async (req, res) => {
  const { page, limit, skip } = pageParams(req);
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
  const lowOnly = req.query.lowStock === 'true';
  const where: Prisma.ProductVariantWhereInput = {
    ...(search
      ? { OR: [{ sku: { contains: search, mode: 'insensitive' } }, { product: { name: { contains: search, mode: 'insensitive' } } }] }
      : {}),
    // Optional low-stock-only view for the alert workflow.
    ...(lowOnly ? { inventory: { availableQty: { lte: prisma.inventory.fields.lowStockThreshold } } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.productVariant.findMany({
      where,
      include: {
        product: { select: { id: true, name: true, slug: true, status: true } },
        inventory: true,
      },
      orderBy: { sku: 'asc' },
      skip,
      take: limit,
    }),
    prisma.productVariant.count({ where }),
  ]);
  res.json({ data: items, page, limit, total });
});

// Overview metrics for the Inventory page header. Inventory VALUE is not
// reported: the schema has no cost-price data, and retail prices must not be
// presented as inventory valuation.
adminReportsRouter.get('/inventory/summary', async (_req, res) => {
  const [totalItems, agg, lowStock, outOfStock] = await Promise.all([
    prisma.productVariant.count({ where: { isActive: true } }),
    prisma.inventory.aggregate({ _sum: { availableQty: true, reservedQty: true, soldQty: true } }),
    prisma.inventory.count({ where: { availableQty: { lte: prisma.inventory.fields.lowStockThreshold } } }),
    prisma.inventory.count({ where: { availableQty: 0 } }),
  ]);
  res.json({
    data: {
      totalItems,
      totalUnitsInStock: agg._sum.availableQty ?? 0,
      totalReserved: agg._sum.reservedQty ?? 0,
      totalSold: agg._sum.soldQty ?? 0,
      lowStockItems: lowStock,
      outOfStockItems: outOfStock,
      // No cost-price column exists: valuation is intentionally omitted.
      inventoryValue: null,
    },
  });
});

adminReportsRouter.get('/inventory/movements', async (req, res) => {
  const { page, limit, skip } = pageParams(req, 60, 50);
  const sku = typeof req.query.sku === 'string' ? req.query.sku.trim() : undefined;
  // InventoryMovement relates to Inventory (by variantId), not directly to
  // ProductVariant: traverse inventory -> variant.
  const where: Prisma.InventoryMovementWhereInput = sku ? { inventory: { variant: { sku } } } : {};
  const [items, total] = await Promise.all([
    prisma.inventoryMovement.findMany({
      where,
      include: { inventory: { select: { variant: { select: { sku: true, product: { select: { name: true } } } } } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.inventoryMovement.count({ where }),
  ]);
  // Flatten to the documented response shape (variant at the top level) so
  // the admin frontend contract is unchanged. The nested `variant` object is
  // ALSO included: the frontend Inventory page renders m.variant.sku /
  // m.variant.product.name, and this endpoint previously returned only the
  // flat fields - causing a TypeError (reading 'sku' of undefined) that
  // crashed the whole Inventory page to a blank screen. Both shapes are
  // served for backwards compatibility.
  res.json({
    data: items.map((m) => ({
      id: m.id,
      variantId: m.variantId,
      sku: m.inventory?.variant.sku ?? null,
      product: m.inventory?.variant.product.name ?? null,
      variant: {
        sku: m.inventory?.variant.sku ?? null,
        product: { name: m.inventory?.variant.product.name ?? null },
      },
      deltaQty: m.deltaQty,
      type: m.type,
      reference: m.reference,
      actorId: m.actorId,
      createdAt: m.createdAt,
    })),
    page,
    limit,
    total,
  });
});
