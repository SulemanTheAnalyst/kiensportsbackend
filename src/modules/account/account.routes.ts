import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { notFound } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { listCustomerOrders } from '../order/order.service';
import { paiseToRupees } from '../../lib/money';

export const accountRouter = Router();
accountRouter.use(requireAuth);

// --- Profile ---
accountRouter.get('/', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.sub },
    include: { roles: { include: { role: true } } },
  });
  if (!user) throw notFound('Account not found');
  res.json({
    data: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      emailVerified: !!user.emailVerifiedAt,
      roles: user.roles.map((r) => r.role.name),
      createdAt: user.createdAt,
    },
  });
});

accountRouter.patch(
  '/',
  validate({
    body: z.object({
      firstName: z.string().min(1).max(80).optional(),
      lastName: z.string().min(1).max(80).optional(),
      phone: z.string().regex(/^(\+91)?[6-9][0-9]{9}$/).optional().or(z.literal('')),
    }),
  }),
  async (req, res) => {
    const user = await prisma.user.update({ where: { id: req.user!.sub }, data: req.body });
    res.json({ data: { id: user.id, firstName: user.firstName, lastName: user.lastName, phone: user.phone } });
  },
);

// --- Addresses ---
const addressSchema = z.object({
  label: z.string().max(40).default('Home'),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  line1: z.string().min(3).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(2).max(80),
  state: z.string().min(2).max(80),
  pincode: z.string().regex(/^[1-9][0-9]{5}$/),
  phone: z.string().regex(/^(\+91)?[6-9][0-9]{9}$/),
  isDefault: z.boolean().default(false),
});

accountRouter.get('/addresses', async (req, res) => {
  const addresses = await prisma.address.findMany({
    where: { userId: req.user!.sub },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });
  res.json({ data: addresses });
});

accountRouter.post(
  '/addresses',
  validate({ body: addressSchema }),
  async (req, res) => {
    const { isDefault } = req.body;
    const address = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.address.updateMany({ where: { userId: req.user!.sub }, data: { isDefault: false } });
      }
      return tx.address.create({ data: { ...req.body, userId: req.user!.sub } });
    });
    res.status(201).json({ data: address });
  },
);

accountRouter.patch(
  '/addresses/:id',
  validate({ params: z.object({ id: z.string().min(10).max(40) }), body: addressSchema.partial() }),
  async (req, res) => {
    const existing = await prisma.address.findFirst({ where: { id: req.params.id, userId: req.user!.sub } });
    if (!existing) throw notFound('Address not found');
    const { isDefault } = req.body;
    const address = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.address.updateMany({ where: { userId: req.user!.sub }, data: { isDefault: false } });
      }
      return tx.address.update({ where: { id: existing.id }, data: req.body });
    });
    res.json({ data: address });
  },
);

accountRouter.delete(
  '/addresses/:id',
  validate({ params: z.object({ id: z.string().min(10).max(40) }) }),
  async (req, res) => {
    const existing = await prisma.address.findFirst({ where: { id: req.params.id, userId: req.user!.sub } });
    if (!existing) throw notFound('Address not found');
    await prisma.address.delete({ where: { id: existing.id } });
    res.json({ data: { ok: true } });
  },
);

// --- Order history (drives the frontend AccountPage "Orders" tab) ---
accountRouter.get('/orders', async (req, res) => {
  const orders = await listCustomerOrders(req.user!.sub);
  res.json({ data: orders });
});

// --- Wishlist (drives the frontend WishlistPage / account wishlist tab) ---
accountRouter.get('/wishlist', async (req, res) => {
  const items = await prisma.wishlistItem.findMany({
    where: { userId: req.user!.sub },
    orderBy: { createdAt: 'desc' },
    include: {
      product: {
        include: {
          images: { orderBy: { sortOrder: 'asc' }, take: 1 },
          variants: { where: { isActive: true }, include: { inventory: true } },
        },
      },
    },
  });
  res.json({
    data: items.map((item) => ({
      id: item.id,
      productId: item.productId,
      name: item.product.name,
      slug: item.product.slug,
      price: paiseToRupees(item.product.pricePaise),
      color: item.product.variants[0]?.colorName ?? '',
      image: item.product.images[0]?.url ?? null,
      inStock: item.product.variants.some((v) => (v.inventory?.availableQty ?? 0) > 0),
    })),
  });
});

accountRouter.post(
  '/wishlist/:productId',
  validate({ params: z.object({ productId: z.string().min(10).max(40) }) }),
  async (req, res) => {
    const product = await prisma.product.findFirst({
      where: { id: req.params.productId, status: 'ACTIVE' },
    });
    if (!product) throw notFound('Product not found');
    await prisma.wishlistItem.upsert({
      where: { userId_productId: { userId: req.user!.sub, productId: product.id } },
      update: {},
      create: { userId: req.user!.sub, productId: product.id },
    });
    res.status(201).json({ data: { ok: true } });
  },
);

accountRouter.delete(
  '/wishlist/:productId',
  validate({ params: z.object({ productId: z.string().min(10).max(40) }) }),
  async (req, res) => {
    await prisma.wishlistItem.deleteMany({
      where: { userId: req.user!.sub, productId: req.params.productId },
    });
    res.json({ data: { ok: true } });
  },
);
