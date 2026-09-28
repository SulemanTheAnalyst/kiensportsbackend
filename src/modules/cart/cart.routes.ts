import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { optionalAuth } from '../../middleware/auth';
import { getOrCreateCart, setCartCookieIfNeeded, CART_COOKIE } from './cart.session';
import { addItem, updateItem, removeItem, serializeCart } from './cart.service';
import { prisma } from '../../lib/prisma';
import { notFound } from '../../lib/errors';

export const cartRouter = Router();
cartRouter.use(optionalAuth);

cartRouter.get('/', async (req, res) => {
  const cart = await getOrCreateCart(req);
  setCartCookieIfNeeded(req, res, cart);
  res.json({ data: serializeCart(cart) });
});

cartRouter.post(
  '/items',
  validate({
    body: z.object({
      variantId: z.string().min(10).max(40),
      quantity: z.coerce.number().int().min(1).max(20).default(1),
    }),
  }),
  async (req, res) => {
    const cart = await getOrCreateCart(req);
    const updated = await addItem(cart.id, req.body.variantId, req.body.quantity);
    setCartCookieIfNeeded(req, res, cart);
    res.status(201).json({ data: serializeCart(updated) });
  },
);

cartRouter.patch(
  '/items/:itemId',
  validate({
    params: z.object({ itemId: z.string().min(10).max(40) }),
    body: z.object({ quantity: z.coerce.number().int().min(0).max(20) }),
  }),
  async (req, res) => {
    const cart = await getOrCreateCart(req);
    const updated = await updateItem(cart.id, req.params.itemId, req.body.quantity);
    res.json({ data: serializeCart(updated) });
  },
);

cartRouter.delete(
  '/items/:itemId',
  validate({ params: z.object({ itemId: z.string().min(10).max(40) }) }),
  async (req, res) => {
    const cart = await getOrCreateCart(req);
    const updated = await removeItem(cart.id, req.params.itemId);
    res.json({ data: serializeCart(updated) });
  },
);

// Lightweight shipping/total quote used by the checkout summary.
cartRouter.get('/quote', async (req, res) => {
  const cart = await getOrCreateCart(req);
  const serialized = serializeCart(cart);
  res.json({
    data: {
      subtotal: serialized.subtotal,
      shipping: serialized.shipping,
      total: serialized.total,
      freeShippingThreshold: 2000,
    },
  });
});

// Ownership guard helper for future per-item routes.
export const assertCartOwner = (userId: string | null | undefined, cartUserId: string | null) => {
  if (userId && cartUserId && userId !== cartUserId) throw notFound('Cart item not found');
};
