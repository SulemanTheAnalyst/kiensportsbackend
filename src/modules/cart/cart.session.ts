import { Request } from 'express';
import { prisma } from '../../lib/prisma';
import { randomToken } from '../../lib/ids';
import { isProd } from '../../config/env';

export const CART_COOKIE = 'kien_cart';

export const cartCookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax' as const, // must be Lax: users arrive from links/redirects
  path: '/api/v1',
  maxAge: 30 * 86400_000,
};

// Find or create the cart bound to the kien_cart cookie.
// When an authenticated user exists, the cart is (re)attached to that user,
// merging a guest cart into the account cart after login.
export const getOrCreateCart = async (req: Request) => {
  const token = req.cookies?.[CART_COOKIE] as string | undefined;
  const userId = req.user?.sub;

  if (token) {
    const existing = await prisma.cart.findUnique({ where: { sessionToken: token } });
    if (existing && existing.status === 'ACTIVE') {
      if (userId && existing.userId !== userId) {
        const merged = await mergeCarts(existing.id, userId);
        return merged;
      }
      if (userId && !existing.userId) {
        return prisma.cart.update({ where: { id: existing.id }, data: { userId }, include: cartInclude });
      }
      return prisma.cart.findUniqueOrThrow({ where: { id: existing.id }, include: cartInclude });
    }
  }

  const cart = await prisma.cart.create({
    data: { sessionToken: randomToken(24), userId: userId ?? null },
    include: cartInclude,
  });
  return cart;
};

export const setCartCookieIfNeeded = (req: Request, res: { cookie: (name: string, val: string, opts: unknown) => void }, cart: { sessionToken: string }) => {
  if ((req.cookies?.[CART_COOKIE] as string | undefined) !== cart.sessionToken) {
    res.cookie(CART_COOKIE, cart.sessionToken, cartCookieOptions);
  }
};

const cartInclude = {
  items: {
    include: { variant: { include: { product: { include: { images: { orderBy: { sortOrder: 'asc' as const } } } } }, inventory: true } },
  },
} as const;

// Merge guest cart into the user's active cart; dedupe by variant.
const mergeCarts = async (guestCartId: string, userId: string) => {
  return prisma.$transaction(async (tx) => {
    const [guest, userCart] = await Promise.all([
      tx.cart.findUniqueOrThrow({ where: { id: guestCartId }, include: { items: true } }),
      tx.cart.findFirst({ where: { userId, status: 'ACTIVE' }, include: { items: true } }),
    ]);
    if (!userCart) {
      return tx.cart.update({ where: { id: guestCartId }, data: { userId }, include: cartInclude });
    }
    if (userCart.id !== guest.id) {
      for (const item of guest.items) {
        const dupe = userCart.items.find((i) => i.variantId === item.variantId);
        if (dupe) {
          await tx.cartItem.update({ where: { id: dupe.id }, data: { quantity: dupe.quantity + item.quantity } });
          await tx.cartItem.delete({ where: { id: item.id } });
        } else {
          await tx.cartItem.update({ where: { id: item.id }, data: { cartId: userCart.id } });
        }
      }
      await tx.cart.update({ where: { id: guestCartId }, data: { status: 'CONVERTED' } });
    }
    return tx.cart.findUniqueOrThrow({ where: { id: userCart.id }, include: cartInclude });
  });
};
