import { Router } from 'express';
import { z } from 'zod';
import { ProductStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { notFound, badRequest } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';
import { paiseToRupees, rupeesToPaise } from '../../lib/money';
import { audit } from '../../lib/audit';
import { notifyOrderCancelled, notifyOrderConfirmed, notifyOrderShipped } from '../email/order.emails';
import { destroyMedia, type StoredAssetRef } from './media.storage';

// All admin routes require an authenticated user with the ADMIN role
// (enforced below with requireRole) and mutations are audit-logged.
export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('ADMIN'));

// ---------------- Products ----------------

const variantSchema = z.object({
  sku: z.string().min(3).max(60).regex(/^[A-Z0-9-]+$/),
  colorName: z.string().min(1).max(60),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  size: z.string().max(30).optional().nullable(),
  price: z.number().int().positive().optional(), // rupees override
  inventoryQty: z.number().int().min(0).default(0),
});

const productBodySchema = z.object({
  slug: z.string().min(2).max(120).regex(/^[a-z0-9-]+$/),
  name: z.string().min(2).max(200),
  shortDescription: z.string().max(500),
  description: z.string().min(10).max(10000),
  categorySlug: z.string().min(2).max(60),
  collectionSlug: z.string().max(60).optional().nullable(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).default('DRAFT'),
  price: z.number().int().positive(), // rupees
  compareAtPrice: z.number().int().positive().optional().nullable(),
  isFeatured: z.boolean().default(false),
  isNewArrival: z.boolean().default(false),
  isBestSeller: z.boolean().default(false),
  dimensions: z.string().max(120).optional().nullable(),
  weightGrams: z.number().int().positive().optional().nullable(),
  capacity: z.string().max(60).optional().nullable(),
  materials: z.array(z.string().max(120)).default([]),
  tags: z.array(z.string().max(40)).default([]),
  seoTitle: z.string().max(200).optional().nullable(),
  seoDescription: z.string().max(500).optional().nullable(),
  images: z.array(z.object({ url: z.string().url().max(500), alt: z.string().max(200).optional(), colorName: z.string().max(60).optional(), mediaType: z.enum(['IMAGE', 'VIDEO']).optional(), publicId: z.string().max(300).optional(), format: z.string().max(20).optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(), durationSeconds: z.number().int().positive().optional() })).default([]),
  features: z.array(z.object({ title: z.string().max(120), description: z.string().max(1000), icon: z.string().max(60).optional() })).default([]),
  variants: z.array(variantSchema).min(1),
});

// Update schemas: image entries may carry an existing `id`.
// Entries with an id are updated (and re-ordered by array position);
// entries without an id are created; existing rows whose ids are absent
// from the array are deleted. This keeps every PATCH atomic.
// media fields (mediaType/publicId/format/dimensions/duration) persist
// Cloudinary asset metadata; rows created before the media upgrade keep
// their defaults (IMAGE, no publicId) and continue to work unchanged.
const imageUpdateSchema = z.object({
  id: z.string().min(10).max(40).optional(),
  url: z.string().url().max(500),
  alt: z.string().max(200).optional().nullable(),
  colorName: z.string().max(60).optional().nullable(),
  mediaType: z.enum(['IMAGE', 'VIDEO']).optional(),
  publicId: z.string().max(300).optional().nullable(),
  format: z.string().max(20).optional().nullable(),
  width: z.number().int().positive().optional().nullable(),
  height: z.number().int().positive().optional().nullable(),
  durationSeconds: z.number().int().positive().optional().nullable(),
});

const featureUpdateSchema = z.object({
  id: z.string().min(10).max(40).optional(),
  title: z.string().max(120),
  description: z.string().max(1000),
  icon: z.string().max(60).optional().nullable(),
});

const productUpdateSchema = productBodySchema.partial().extend({
  images: z.array(imageUpdateSchema).optional(),
  features: z.array(featureUpdateSchema).optional(),
});

adminRouter.get('/products', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 25));
  const [items, total] = await Promise.all([
    prisma.product.findMany({
      include: { category: true, collection: true, variants: { include: { inventory: true } }, _count: { select: { reviews: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.product.count(),
  ]);
  res.json({
    data: items.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      status: p.status,
      category: p.category.slug,
      world: p.category.world,
      collection: p.collection?.slug ?? null,
      price: paiseToRupees(p.pricePaise),
      totalAvailable: p.variants.reduce((a, v) => a + (v.inventory?.availableQty ?? 0), 0),
      variantCount: p.variants.length,
    })),
    page,
    limit,
    total,
  });
});

adminRouter.post(
  '/products',
  validate({ body: productBodySchema }),
  async (req, res) => {
    const body = req.body as z.infer<typeof productBodySchema>;
    const category = await prisma.category.findUnique({ where: { slug: body.categorySlug } });
    if (!category) throw badRequest('Unknown categorySlug');
    const dup = await prisma.product.findUnique({ where: { slug: body.slug } });
    if (dup) throw badRequest('A product with this slug already exists');
    const skus = body.variants.map((v) => v.sku);
    if (new Set(skus).size !== skus.length) throw badRequest('Duplicate SKUs in request');

    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          slug: body.slug,
          name: body.name,
          shortDescription: body.shortDescription,
          description: body.description,
          status: body.status as ProductStatus,
          pricePaise: rupeesToPaise(body.price),
          compareAtPaise: body.compareAtPrice ? rupeesToPaise(body.compareAtPrice) : null,
          isFeatured: body.isFeatured,
          isNewArrival: body.isNewArrival,
          isBestSeller: body.isBestSeller,
          dimensions: body.dimensions ?? null,
          weightGrams: body.weightGrams ?? null,
          capacity: body.capacity ?? null,
          materials: body.materials,
          tags: body.tags.map((t) => t.toLowerCase()),
          seoTitle: body.seoTitle ?? null,
          seoDescription: body.seoDescription ?? null,
          category: { connect: { id: category.id } },
          collection: body.collectionSlug ? { connect: { slug: body.collectionSlug } } : undefined,
          images: {
            create: body.images.map((i, idx) => ({
              url: i.url,
              alt: i.alt,
              colorName: i.colorName,
              mediaType: i.mediaType ?? 'IMAGE',
              publicId: i.publicId ?? null,
              format: i.format ?? null,
              width: i.width ?? null,
              height: i.height ?? null,
              durationSeconds: i.durationSeconds ?? null,
              sortOrder: idx,
            })),
          },
          features: { create: body.features.map((f, idx) => ({ ...f, sortOrder: idx })) },
          variants: {
            create: body.variants.map((v) => ({
              sku: v.sku,
              colorName: v.colorName,
              colorHex: v.colorHex,
              size: v.size ?? null,
              pricePaise: v.price ? rupeesToPaise(v.price) : null,
              inventory: { create: { availableQty: v.inventoryQty } },
            })),
          },
        },
      });
      for (const v of body.variants) {
        if (v.inventoryQty > 0) {
          await tx.inventoryMovement.create({
            data: { variantId: (await tx.productVariant.findUniqueOrThrow({ where: { sku: v.sku } })).id, deltaQty: v.inventoryQty, type: 'RESTOCK', reference: 'initial:' + created.slug, actorId: req.user!.sub },
          });
        }
      }
      return created;
    });
    await audit(req.user!.sub, 'PRODUCT_CREATED', 'Product', product.id, { slug: product.slug }, req.ip);
    res.status(201).json({ data: { id: product.id, slug: product.slug } });
  },
);

adminRouter.patch(
  '/products/:id',
  validate({ params: z.object({ id: z.string().min(10).max(40) }), body: productUpdateSchema }),
  async (req, res) => {
    const body = req.body as z.infer<typeof productUpdateSchema>;
    const productId = String(req.params.id);

    // Validate references BEFORE opening the transaction so bad requests
    // fail fast without any writes.
    if (body.categorySlug !== undefined) {
      const category = await prisma.category.findUnique({ where: { slug: body.categorySlug } });
      if (!category) throw badRequest('Unknown categorySlug');
    }
    if (body.collectionSlug) {
      const collection = await prisma.collection.findUnique({ where: { slug: body.collectionSlug } });
      if (!collection) throw badRequest('Unknown collectionSlug');
    }
    const existing = await prisma.product.findUnique({
      where: { id: productId },
      include: { images: true, features: true },
    });
    if (!existing) throw notFound('Product not found');
    if (body.slug !== undefined && body.slug !== existing.slug) {
      const dup = await prisma.product.findUnique({ where: { slug: body.slug } });
      if (dup) throw badRequest('A product with this slug already exists');
    }
    if (body.images) {
      const ids = body.images.filter((i) => i.id).map((i) => i.id!);
      if (new Set(ids).size !== ids.length) throw badRequest('Duplicate image ids in request');
      const owned = new Set(existing.images.map((i) => i.id));
      for (const id of ids) {
        if (!owned.has(id)) throw badRequest('Image id does not belong to this product');
      }
    }
    if (body.features) {
      const ids = body.features.filter((f) => f.id).map((f) => f.id!);
      if (new Set(ids).size !== ids.length) throw badRequest('Duplicate feature ids in request');
      const owned = new Set(existing.features.map((f) => f.id));
      for (const id of ids) {
        if (!owned.has(id)) throw badRequest('Feature id does not belong to this product');
      }
    }

    const data: Prisma.ProductUpdateInput = {};
    if (body.slug !== undefined) data.slug = body.slug;
    if (body.name !== undefined) data.name = body.name;
    if (body.shortDescription !== undefined) data.shortDescription = body.shortDescription;
    if (body.description !== undefined) data.description = body.description;
    if (body.status !== undefined) data.status = body.status as ProductStatus;
    if (body.price !== undefined) data.pricePaise = rupeesToPaise(body.price);
    if (body.compareAtPrice !== undefined) data.compareAtPaise = body.compareAtPrice ? rupeesToPaise(body.compareAtPrice) : null;
    if (body.isFeatured !== undefined) data.isFeatured = body.isFeatured;
    if (body.isNewArrival !== undefined) data.isNewArrival = body.isNewArrival;
    if (body.isBestSeller !== undefined) data.isBestSeller = body.isBestSeller;
    if (body.dimensions !== undefined) data.dimensions = body.dimensions ?? null;
    if (body.weightGrams !== undefined) data.weightGrams = body.weightGrams ?? null;
    if (body.capacity !== undefined) data.capacity = body.capacity ?? null;
    if (body.materials !== undefined) data.materials = body.materials;
    if (body.tags !== undefined) data.tags = body.tags.map((t) => t.toLowerCase());
    if (body.seoTitle !== undefined) data.seoTitle = body.seoTitle ?? null;
    if (body.seoDescription !== undefined) data.seoDescription = body.seoDescription ?? null;
    if (body.categorySlug !== undefined) data.category = { connect: { slug: body.categorySlug } };
    if (body.collectionSlug !== undefined) data.collection = body.collectionSlug ? { connect: { slug: body.collectionSlug } } : { disconnect: true };

    const removedMedia: StoredAssetRef[] = [];
    const updated = await prisma.$transaction(async (tx) => {
      if (body.images) {
        const keptIds = new Set(body.images.filter((i) => i.id).map((i) => i.id!));
        for (const img of existing.images) {
          if (!keptIds.has(img.id)) {
            removedMedia.push({ url: img.url, publicId: img.publicId, mediaType: img.mediaType === 'VIDEO' ? 'VIDEO' : 'IMAGE' });
            await tx.productImage.delete({ where: { id: img.id } });
          }
        }
        let sortOrder = 0;
        for (const img of body.images) {
          const fields = {
            url: img.url,
            alt: img.alt ?? null,
            colorName: img.colorName ?? null,
            mediaType: img.mediaType ?? 'IMAGE',
            publicId: img.publicId ?? null,
            format: img.format ?? null,
            width: img.width ?? null,
            height: img.height ?? null,
            durationSeconds: img.durationSeconds ?? null,
            sortOrder,
          };
          if (img.id) {
            await tx.productImage.update({ where: { id: img.id }, data: fields });
          } else {
            await tx.productImage.create({ data: { productId: existing.id, ...fields } });
          }
          sortOrder += 1;
        }
      }
      if (body.features) {
        const keptIds = new Set(body.features.filter((f) => f.id).map((f) => f.id!));
        for (const feature of existing.features) {
          if (!keptIds.has(feature.id)) {
            await tx.productFeature.delete({ where: { id: feature.id } });
          }
        }
        let sortOrder = 0;
        for (const feature of body.features) {
          const fields = {
            title: feature.title,
            description: feature.description,
            icon: feature.icon ?? null,
            sortOrder,
          };
          if (feature.id) {
            await tx.productFeature.update({ where: { id: feature.id }, data: fields });
          } else {
            await tx.productFeature.create({ data: { productId: existing.id, ...fields } });
          }
          sortOrder += 1;
        }
      }
      return tx.product.update({ where: { id: existing.id }, data });
    });
    await audit(req.user!.sub, 'PRODUCT_UPDATED', 'Product', updated.id, body, req.ip);

    // Best-effort cleanup AFTER the commit, and only for assets that are no
    // longer referenced by any product (shared/seed URLs are never destroyed).
    // If the transaction had failed, nothing would have been deleted, so a
    // failed save never destroys an asset that is still attached to a product.
    for (const asset of removedMedia) {
      const stillUsed = await prisma.productImage.findFirst({ where: { url: asset.url } });
      if (!stillUsed) await destroyMedia(asset);
    }
    res.json({ data: { id: updated.id, slug: updated.slug } });
  },
);

// One-click archive: the safe alternative to deletion for products with order
// history. Idempotent. Keeps the product (and its order references) intact
// while removing it from the storefront (status ARCHIVED is not listed).
adminRouter.post(
  '/products/:id/archive',
  validate({ params: z.object({ id: z.string().min(10).max(40) }) }),
  async (req, res) => {
    const product = await prisma.product.findUnique({ where: { id: String(req.params.id) } });
    if (!product) throw notFound('Product not found');
    if (product.status === 'ARCHIVED') {
      return res.json({ data: { id: product.id, slug: product.slug, status: product.status } });
    }
    const updated = await prisma.product.update({ where: { id: product.id }, data: { status: 'ARCHIVED' } });
    await audit(req.user!.sub, 'PRODUCT_ARCHIVED', 'Product', product.id, { slug: product.slug, from: product.status }, req.ip);
    res.json({ data: { id: updated.id, slug: updated.slug, status: updated.status } });
  },
);

// Hard delete. Refused (409) when the product has ever appeared on an order -
// historical transaction data must never be destroyed. For products without
// order history the delete cascades to images/features/variants/inventory
// (all schema-level Cascade relations), is audit-logged, and removes only
// assets hosted in our own storage.
adminRouter.delete(
  '/products/:id',
  validate({ params: z.object({ id: z.string().min(10).max(40) }) }),
  async (req, res) => {
    const product = await prisma.product.findUnique({
      where: { id: String(req.params.id) },
      include: { images: true },
    });
    if (!product) throw notFound('Product not found');

    const orderItemCount = await prisma.orderItem.count({
      where: { variant: { productId: product.id } },
    });
    if (orderItemCount > 0) {
      return res.status(409).json({
        error: {
          code: 'PRODUCT_HAS_ORDERS',
          message:
            'This product has ' + orderItemCount + ' order item(s) and cannot be deleted without destroying order history. Archive it instead.',
          orderItemCount,
        },
      });
    }

    const assets: StoredAssetRef[] = product.images.map((i) => ({
      url: i.url,
      publicId: i.publicId,
      mediaType: i.mediaType === 'VIDEO' ? 'VIDEO' : 'IMAGE',
    }));
    await prisma.$transaction(async (tx) => {
      await tx.product.delete({ where: { id: product.id } });
    });
    await audit(req.user!.sub, 'PRODUCT_DELETED', 'Product', product.id, { slug: product.slug, name: product.name }, req.ip);

    // Best-effort storage cleanup; only unreferenced hosted assets.
    for (const asset of assets) {
      const stillUsed = await prisma.productImage.findFirst({ where: { url: asset.url } });
      if (!stillUsed) await destroyMedia(asset);
    }
    res.json({ data: { id: product.id, deleted: true } });
  },
);

// ---------------- Inventory ----------------

adminRouter.post(
  '/inventory/adjust',
  validate({
    body: z.object({
      sku: z.string().min(3).max(60),
      deltaQty: z.number().int(),
      type: z.enum(['RESTOCK', 'ADJUST']).default('ADJUST'),
      reason: z.string().max(300).optional(),
    }),
  }),
  async (req, res) => {
    const variant = await prisma.productVariant.findUnique({ where: { sku: req.body.sku }, include: { inventory: true } });
    if (!variant) throw notFound('Variant not found for SKU ' + req.body.sku);
    const newQty = (variant.inventory?.availableQty ?? 0) + req.body.deltaQty;
    if (newQty < 0) throw badRequest('Adjustment would make stock negative');
    const result = await prisma.$transaction(async (tx) => {
      const inv = await tx.inventory.update({
        where: { variantId: variant.id },
        data: { availableQty: newQty },
      });
      await tx.inventoryMovement.create({
        data: { variantId: variant.id, deltaQty: req.body.deltaQty, type: req.body.type, reference: req.body.reason, actorId: req.user!.sub },
      });
      return inv;
    });
    await audit(req.user!.sub, 'INVENTORY_ADJUSTED', 'Inventory', variant.id, req.body, req.ip);
    res.json({ data: { sku: req.body.sku, availableQty: result.availableQty } });
  },
);

adminRouter.get('/inventory/low-stock', async (_req, res) => {
  const low = await prisma.inventory.findMany({
    where: { availableQty: { lte: prisma.inventory.fields.lowStockThreshold } },
    include: { variant: { include: { product: { select: { name: true, slug: true } } } } },
  });
  res.json({
    data: low.map((i) => ({
      sku: i.variant.sku,
      product: i.variant.product.name,
      availableQty: i.availableQty,
      reservedQty: i.reservedQty,
      threshold: i.lowStockThreshold,
    })),
  });
});

// ---------------- Orders ----------------

adminRouter.get('/orders', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 25));
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const where = status ? { status: status as never } : {};
  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { items: true, payments: true, shipments: true },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.order.count({ where }),
  ]);
  res.json({ data: items, page, limit, total });
});

adminRouter.post(
  '/orders/:orderNumber/transition',
  validate({
    params: z.object({ orderNumber: z.string().min(6).max(40) }),
    body: z.object({
      toStatus: z.enum(['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED']),
      note: z.string().max(500).optional(),
    }),
  }),
  async (req, res) => {
    const order = await prisma.order.findUnique({
      where: { orderNumber: String(req.params.orderNumber) },
      include: { items: true, statusEvents: true },
    });
    if (!order) throw notFound('Order not found');
    const to = req.body.toStatus;
    if (order.status === to) throw badRequest('Order already in status ' + to);
    // Guard: only CONFIRMED orders can move to PROCESSING+; cancellation rules.
    if (order.paymentStatus !== 'PAID' && to !== 'CANCELLED' && to !== 'CONFIRMED') {
      throw badRequest('Order must be paid before fulfilment transitions');
    }
    const updated = await prisma.$transaction(async (tx) => {
      const o = await tx.order.update({ where: { id: order.id }, data: { status: to } });
      await tx.orderStatusEvent.create({
        data: { orderId: order.id, fromStatus: order.status, toStatus: to, note: req.body.note, actorId: req.user!.sub },
      });
      // Cancellation releases reserved/sold stock.
      if (to === 'CANCELLED') {
        const paid = o.paymentStatus === 'PAID';
        for (const item of order.items) {
          if (!item.variantId) continue;
          await tx.inventory.update({
            where: { variantId: item.variantId },
            data: paid
              ? { soldQty: { decrement: item.quantity }, availableQty: { increment: item.quantity } }
              : { reservedQty: { decrement: item.quantity }, availableQty: { increment: item.quantity } },
          });
          await tx.inventoryMovement.create({
            data: { variantId: item.variantId, deltaQty: item.quantity, type: 'RELEASE', reference: o.orderNumber, actorId: req.user!.sub },
          });
        }
      }
      return o;
    });
    await audit(req.user!.sub, 'ORDER_STATUS_CHANGED', 'Order', order.id, { from: order.status, to }, req.ip);
    // Best-effort customer notifications AFTER the transaction committed.
    // Idempotent via event markers; CONFIRMED covers the COD flow (the
    // Razorpay path confirms via verified webhook in order.service).
    if (to === 'CONFIRMED') notifyOrderConfirmed(updated.orderNumber);
    if (to === 'SHIPPED') notifyOrderShipped(updated.orderNumber);
    if (to === 'CANCELLED') notifyOrderCancelled(updated.orderNumber);
    res.json({ data: { orderNumber: updated.orderNumber, status: updated.status } });
  },
);

// ---------------- Audit trail viewer ----------------

adminRouter.get('/audit-logs', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * 50,
    take: 50,
  });
  res.json({ data: logs, page });
});
