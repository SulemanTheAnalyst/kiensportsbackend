import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { optionalAuth } from '../../middleware/auth';
import { apiLimiter } from '../../middleware/errorHandler';
import { notifyCartAdd } from '../notifications/notifications';
import { getOrCreateCart, setCartCookieIfNeeded, CART_COOKIE } from './cart.session';
import { addItem, updateItem, removeItem, serializeCart } from './cart.service';
import { getShippingRule } from '../settings/settings.service';
import { prisma } from '../../lib/prisma';
import { notFound } from '../../lib/errors';

export const cartRouter = Router();
cartRouter.use(optionalAuth);

cartRouter.get('/', async (req, res) => {
  const cart = await getOrCreateCart(req);
  setCartCookieIfNeeded(req, res, cart);
  // Shipping uses the configured business rule (Settings -> Payments &
  // Checkout); the frontend always displays what the backend enforces.
  res.json({ data: serializeCart(cart, await getShippingRule()) });
});

cartRouter.post(
  '/items',
  // Abuse protection for the notification hook: bounded request rate.
  apiLimiter(60_000, 60),
  validate({
    body: z.object({
      variantId: z.string().min(10).max(40),
      quantity: z.coerce.number().int().min(1).max(20).default(1),
    }),
  }),
  async (req, res) => {
    const cart = await getOrCreateCart(req);
    // Meaningful-add detection: only the first time a variant enters this
    // cart (within the notification cooldown window) triggers a business
    // notification. Quantity bumps and repeated clicks do not. The event is
    // recorded server-side; a cart addition is never described as a purchase.
    const existing = await prisma.cartItem.findUnique({
      where: { cartId_variantId: { cartId: cart.id, variantId: req.body.variantId } },
    });
    const updated = await addItem(cart.id, req.body.variantId, req.body.quantity);
    setCartCookieIfNeeded(req, res, cart);
    if (!existing) {
      await notifyCartAdd({
        cartId: cart.id,
        variantId: req.body.variantId,
        quantity: req.body.quantity,
        userId: req.user?.sub ?? null,
      });
    }
    res.status(201).json({ data: serializeCart(updated, await getShippingRule()) });
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
    const updated = await updateItem(cart.id, String(req.params.itemId), req.body.quantity);
    res.json({ data: serializeCart(updated, await getShippingRule()) });
  },
);

cartRouter.delete(
  '/items/:itemId',
  validate({ params: z.object({ itemId: z.string().min(10).max(40) }) }),
  async (req, res) => {
    const cart = await getOrCreateCart(req);
    const updated = await removeItem(cart.id, String(req.params.itemId));
    res.json({ data: serializeCart(updated, await getShippingRule()) });
  },
);

// Lightweight shipping/total quote used by the checkout summary.
cartRouter.get('/quote', async (req, res) => {
  const cart = await getOrCreateCart(req);
  const rule = await getShippingRule();
  const serialized = serializeCart(cart, rule);
  res.json({
    data: {
      subtotal: serialized.subtotal,
      shipping: serialized.shipping,
      total: serialized.total,
      freeShippingThreshold: Math.round(rule.freeShippingThresholdPaise / 100),
    },
  });
});

// Ownership guard helper for future per-item routes.
export const assertCartOwner = (userId: string | null | undefined, cartUserId: string | null) => {
  if (userId && cartUserId && userId !== cartUserId) throw notFound('Cart item not found');
};
