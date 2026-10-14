import { Router } from 'express';
import { Prisma, ProductStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { requireAuth, requireRole } from '../../middleware/auth';
import { paiseToRupees } from '../../lib/money';

/**
 * Admin catalog listing with search/filter support.
 *
 * The original GET /admin/products returns a compact summary without search.
 * This endpoint returns the full product record (images, features, variants
 * with inventory) so the admin edit forms work from real data. Read-only;
 * all writes continue to go through the audited routes in admin.routes.ts.
 * ADMIN role enforced server-side below.
 */
export const adminCatalogRouter = Router();
adminCatalogRouter.use(requireAuth, requireRole('ADMIN'));

adminCatalogRouter.get('/catalog/products', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 25));
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : undefined;
  const status = typeof req.query.status === 'string' ? (req.query.status as ProductStatus) : undefined;
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  const world = typeof req.query.world === 'string' ? req.query.world : undefined;

  const where: Prisma.ProductWhereInput = {
    ...(status ? { status } : {}),
    ...(category ? { category: { slug: category } } : {}),
    ...(world ? { category: { world } } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { slug: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: {
        category: true,
        collection: true,
        images: { orderBy: { sortOrder: 'asc' } },
        features: { orderBy: { sortOrder: 'asc' } },
        variants: { include: { inventory: true }, orderBy: { sku: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.product.count({ where }),
  ]);

  res.json({
    data: items.map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      shortDescription: p.shortDescription,
      description: p.description,
      status: p.status,
      price: paiseToRupees(p.pricePaise),
      compareAtPrice: p.compareAtPaise ? paiseToRupees(p.compareAtPaise) : null,
      categorySlug: p.category.slug,
      categoryName: p.category.name,
      categoryWorld: p.category.world,
      collectionSlug: p.collection?.slug ?? null,
      collectionName: p.collection?.name ?? null,
      isFeatured: p.isFeatured,
      isNewArrival: p.isNewArrival,
      isBestSeller: p.isBestSeller,
      dimensions: p.dimensions,
      weightGrams: p.weightGrams,
      capacity: p.capacity,
      materials: p.materials,
      tags: p.tags,
      seoTitle: p.seoTitle,
      seoDescription: p.seoDescription,
      images: p.images.map((i) => ({ id: i.id, url: i.url, alt: i.alt, colorName: i.colorName, sortOrder: i.sortOrder })),
      features: p.features.map((f) => ({ id: f.id, title: f.title, description: f.description, icon: f.icon, sortOrder: f.sortOrder })),
      variants: p.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        colorName: v.colorName,
        colorHex: v.colorHex,
        size: v.size,
        price: v.pricePaise ? paiseToRupees(v.pricePaise) : null,
        isActive: v.isActive,
        inventory: v.inventory
          ? {
              availableQty: v.inventory.availableQty,
              reservedQty: v.inventory.reservedQty,
              soldQty: v.inventory.soldQty,
              lowStockThreshold: v.inventory.lowStockThreshold,
              updatedAt: v.inventory.updatedAt,
            }
          : null,
      })),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
    page,
    limit,
    total,
  });
});
