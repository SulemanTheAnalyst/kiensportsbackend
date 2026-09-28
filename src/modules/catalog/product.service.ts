import { Prisma, ProductStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { notFound } from '../../lib/errors';
import { paiseToRupees } from '../../lib/money';

// The serialized product mirrors the frontend `Product` TS interface
// (src/types/index.ts) so the frontend can swap static imports for API calls.

type ProductWithRelations = Prisma.ProductGetPayload<{
  include: {
    category: true;
    collection: true;
    images: { orderBy: { sortOrder: 'asc' } };
    features: { orderBy: { sortOrder: 'asc' } };
    variants: { include: { inventory: true }; where: { isActive: true } };
  };
}>;

export const serializeProduct = (p: ProductWithRelations) => {
  const activeVariants = p.variants;
  const colors = [...new Map(activeVariants.map((v) => [v.colorName, v])).values()].map((v) => ({
    name: v.colorName,
    hex: v.colorHex,
    images: p.images
      .filter((i) => !i.colorName || i.colorName === v.colorName)
      .map((i) => i.url),
  }));
  const available = activeVariants.some((v) => (v.inventory?.availableQty ?? 0) > 0);
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    category: p.category.world, // 'sport' | 'lifestyle'
    subcategory: p.category.slug,
    collection: p.collection?.name ?? '',
    price: paiseToRupees(p.pricePaise),
    compareAtPrice: p.compareAtPaise ? paiseToRupees(p.compareAtPaise) : undefined,
    colors,
    sizes: [...new Set(activeVariants.map((v) => v.size).filter((s): s is string => !!s))],
    images: p.images.map((i) => i.url),
    description: p.description,
    shortDescription: p.shortDescription,
    features: p.features.map((f) => ({ title: f.title, description: f.description, icon: f.icon ?? undefined })),
    materials: p.materials,
    dimensions: p.dimensions ?? '',
    weight: p.weightGrams ? p.weightGrams / 1000 + ' kg' : '',
    capacity: p.capacity ?? undefined,
    sku: activeVariants[0]?.sku ?? '',
    tags: p.tags,
    isFeatured: p.isFeatured,
    isNewArrival: p.isNewArrival,
    isBestSeller: p.isBestSeller,
    inStock: available,
    // Extra fields the frontend does not use yet but will need:
    variants: activeVariants.map((v) => ({
      id: v.id,
      sku: v.sku,
      colorName: v.colorName,
      colorHex: v.colorHex,
      size: v.size ?? null,
      price: paiseToRupees(v.pricePaise ?? p.pricePaise),
      availableQty: v.inventory?.availableQty ?? 0,
    })),
  };
};

export type SerializedProduct = ReturnType<typeof serializeProduct>;

const productInclude = {
  category: true,
  collection: true,
  images: { orderBy: { sortOrder: 'asc' as const } },
  features: { orderBy: { sortOrder: 'asc' as const } },
  variants: { where: { isActive: true }, include: { inventory: true } },
} satisfies Prisma.ProductInclude;

export interface ListProductsQuery {
  category?: string; // world: sport | lifestyle
  subcategory?: string;
  collection?: string;
  featured?: boolean;
  newArrival?: boolean;
  bestSeller?: boolean;
  search?: string;
  page?: number;
  limit?: number;
  sort?: 'newest' | 'price-asc' | 'price-desc' | 'name';
}

export const listProducts = async (q: ListProductsQuery) => {
  const page = Math.max(1, q.page ?? 1);
  const limit = Math.min(60, Math.max(1, q.limit ?? 24));
  const where: Prisma.ProductWhereInput = { status: ProductStatus.ACTIVE };
  if (q.category) where.category = { world: q.category };
  if (q.subcategory) where.category = { ...where.category, slug: q.subcategory };
  if (q.collection) where.collection = { slug: q.collection };
  if (q.featured) where.isFeatured = true;
  if (q.newArrival) where.isNewArrival = true;
  if (q.bestSeller) where.isBestSeller = true;
  if (q.search && q.search.trim().length >= 2) {
    const s = q.search.trim();
    where.OR = [
      { name: { contains: s, mode: 'insensitive' } },
      { tags: { has: s.toLowerCase() } },
      { shortDescription: { contains: s, mode: 'insensitive' } },
    ];
  }
  const orderBy: Prisma.ProductOrderByWithRelationInput =
    q.sort === 'price-asc' ? { pricePaise: 'asc' }
    : q.sort === 'price-desc' ? { pricePaise: 'desc' }
    : q.sort === 'name' ? { name: 'asc' }
    : { createdAt: 'desc' };

  const [items, total] = await Promise.all([
    prisma.product.findMany({ where, include: productInclude, orderBy, skip: (page - 1) * limit, take: limit }),
    prisma.product.count({ where }),
  ]);
  return { data: items.map(serializeProduct), page, limit, total };
};

export const getProductBySlug = async (slug: string) => {
  const p = await prisma.product.findFirst({
    where: { slug, status: ProductStatus.ACTIVE },
    include: productInclude,
  });
  if (!p) throw notFound('Product not found: ' + slug);
  return serializeProduct(p);
};

export const listCategories = async (world?: string) => {
  const categories = await prisma.category.findMany({
    where: { isActive: true, ...(world ? { world } : {}) },
    orderBy: { sortOrder: 'asc' },
  });
  const counts = await prisma.product.groupBy({
    by: ['categoryId'],
    where: { status: ProductStatus.ACTIVE },
    _count: { _all: true },
  });
  const countMap = new Map(counts.map((c) => [c.categoryId, c._count._all]));
  return categories.map((c) => ({
    name: c.name,
    slug: c.slug,
    world: c.world,
    hasProducts: (countMap.get(c.id) ?? 0) > 0,
    description: c.description,
  }));
};

export const listCollections = async () => {
  const collections = await prisma.collection.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  const counts = await prisma.product.groupBy({
    by: ['collectionId'],
    where: { status: ProductStatus.ACTIVE },
    _count: { _all: true },
  });
  const countMap = new Map(counts.map((c) => [c.collectionId, c._count._all]));
  return collections.map((c) => ({
    ...c,
    productCount: countMap.get(c.id) ?? 0,
  }));
};
