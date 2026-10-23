import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate';
import { optionalAuth } from '../../middleware/auth';
import { apiLimiter } from '../../middleware/errorHandler';
import { notifyCartAdd } from '../notifications/notifications';
import { getOrCreateCart, setCartCookieIfNeeded, CART_COOKIE } from './cart.session';
import { addItem, updateItem, removeItem, serializeCart } from './cart.service';
import { getSettings, getPricingConfig } from '../settings/settings.service';
import { validateCoupon } from '../coupons/coupon.service';
import { paiseToRupees } from '../../lib/money';
import { prisma } from '../../lib/prisma';
import { notFound } from '../../lib/errors';

export const cartRouter = Router();
cartRouter.use(optionalAuth);

cartRouter.get('/', async (req, res) => {
  const cart = await getOrCreateCart(req);
  setCartCookieIfNeeded(req, res, cart);
  res.json({ data: serializeCart(cart, await getPricingConfig()) });
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
    res.status(201).json({ data: serializeCart(updated, await getPricingConfig()) });
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
    res.json({ data: serializeCart(updated, await getPricingConfig()) });
  },
);

cartRouter.delete(
  '/items/:itemId',
  validate({ params: z.object({ itemId: z.string().min(10).max(40) }) }),
  async (req, res) => {
    const cart = await getOrCreateCart(req);
    const updated = await removeItem(cart.id, String(req.params.itemId));
    res.json({ data: serializeCart(updated, await getPricingConfig()) });
  },
);

// Lightweight shipping/total quote used by the checkout summary.
// Supports an optional coupon code: the backend validates the coupon against
// the CURRENT cart and returns the authoritative discount and totals. The
// client never computes a discount; a failed validation returns the normal
// error envelope with a specific coupon error code.
cartRouter.get(
  '/quote',
  apiLimiter(60_000, 30),
  async (req, res) => {
    const cart = await getOrCreateCart(req);
    const couponCode = typeof req.query.coupon === 'string' ? req.query.coupon.trim() : undefined;

    const lines = cart.items.map((item) => ({
      variantId: item.variantId,
      productId: item.variant.productId,
      quantity: item.quantity,
      unitPricePaise: item.variant.pricePaise ?? item.variant.product.pricePaise,
    }));
    const subtotalPaise = lines.reduce((acc, l) => acc + l.unitPricePaise * l.quantity, 0);

    const settings = await getSettings();
    let shippingPaise = subtotalPaise >= settings.freeShippingThresholdPaise ? 0 : settings.flatShippingPaise;
    let discountPaise = 0;
    let coupon: Record<string, unknown> | null = null;
    if (couponCode) {
      const validated = await validateCoupon(prisma, {
        code: couponCode,
        subtotalPaise,
        cartLines: lines,
        userId: req.user?.sub ?? null,
        email: null,
      });
      discountPaise = validated.discountPaise;
      if (validated.freeShipping) shippingPaise = 0;
      coupon = {
        code: validated.coupon.code,
        discountType: validated.coupon.discountType,
        // Percentage coupons expose points; fixed coupons expose rupees.
        discountValue: validated.coupon.discountType === 'FIXED_AMOUNT' ? validated.coupon.discountValue / 100 : validated.coupon.discountValue,
        freeShipping: validated.freeShipping,
      };
    }
    const totalPaise = subtotalPaise - discountPaise + shippingPaise;
    res.json({
      data: {
        subtotal: paiseToRupees(subtotalPaise),
        discount: paiseToRupees(discountPaise),
        coupon,
        shipping: paiseToRupees(shippingPaise),
        total: paiseToRupees(totalPaise),
        freeShippingThreshold: Math.ceil(settings.freeShippingThresholdPaise / 100),
      },
    });
  },
);

// Ownership guard helper for future per-item routes.
export const assertCartOwner = (userId: string | null | undefined, cartUserId: string | null) => {
  if (userId && cartUserId && userId !== cartUserId) throw notFound('Cart item not found');
};
