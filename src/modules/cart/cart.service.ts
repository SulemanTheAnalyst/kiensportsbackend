import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { notFound, outOfStock } from '../../lib/errors';
import { paiseToRupees, FLAT_SHIPPING_PAISE, FREE_SHIPPING_THRESHOLD_PAISE } from '../../lib/money';
import { ApiError } from '../../lib/errors';

// Validated include + explicit payload type (Prisma's documented pattern).
export const cartInclude = Prisma.validator<Prisma.CartInclude>()({
  items: {
    include: {
      variant: {
        include: {
          product: { include: { images: { orderBy: { sortOrder: 'asc' as const } } } },
          inventory: true,
        },
      },
    },
  },
});

export type Cart = Prisma.CartGetPayload<{ include: typeof cartInclude }>;

export const getActiveCart = (cartId: string): Promise<Cart | null> =>
  prisma.cart.findUnique({ where: { id: cartId }, include: cartInclude }) as Promise<Cart | null>;

// Never trust client prices: the unit price is always resolved from the DB.
export const resolveUnitPricePaise = async (variantId: string): Promise<number> => {
  const variant = await prisma.productVariant.findUnique({
    where: { id: variantId },
    include: { product: true },
  });
  if (!variant || !variant.isActive) throw notFound('Product variant not available');
  if (variant.product.status !== 'ACTIVE') throw notFound('Product not available');
  return variant.pricePaise ?? variant.product.pricePaise;
};

export const checkStock = (variantId: string, sku: string, requested: number, available: number) => {
  if (requested > available) throw outOfStock(sku, requested, available);
};

export const addItem = async (cartId: string, variantId: string, quantity: number) => {
  const unitPricePaise = await resolveUnitPricePaise(variantId);
  const variant = await prisma.productVariant.findUniqueOrThrow({
    where: { id: variantId },
    include: { inventory: true },
  });
  const available = variant.inventory?.availableQty ?? 0;
  if (available < quantity) throw outOfStock(variant.sku, quantity, available);

  const existing = await prisma.cartItem.findUnique({ where: { cartId_variantId: { cartId, variantId } } });
  const newQty = (existing?.quantity ?? 0) + quantity;
  if (newQty > available) throw outOfStock(variant.sku, newQty, available);

  await prisma.cartItem.upsert({
    where: { cartId_variantId: { cartId, variantId } },
    update: { quantity: newQty, unitPricePaise },
    create: { cartId, variantId, quantity, unitPricePaise },
  });
  return getActiveCart(cartId) as Promise<Cart>;
};

export const updateItem = async (cartId: string, itemId: string, quantity: number) => {
  const item = await prisma.cartItem.findFirst({ where: { id: itemId, cartId }, include: { variant: { include: { inventory: true } } } });
  if (!item) throw notFound('Cart item not found');
  if (quantity === 0) {
    await prisma.cartItem.delete({ where: { id: itemId } });
    return getActiveCart(cartId) as Promise<Cart>;
  }
  const available = item.variant.inventory?.availableQty ?? 0;
  checkStock(item.variantId, item.variant.sku, quantity, available);
  await prisma.cartItem.update({ where: { id: itemId }, data: { quantity } });
  return getActiveCart(cartId) as Promise<Cart>;
};

export const removeItem = async (cartId: string, itemId: string) => {
  const item = await prisma.cartItem.findFirst({ where: { id: itemId, cartId } });
  if (!item) throw notFound('Cart item not found');
  await prisma.cartItem.delete({ where: { id: itemId } });
  return getActiveCart(cartId) as Promise<Cart>;
};

// Validate the cart is still purchasable (prices/stock change over time).
export const validateCartForCheckout = async (cart: Cart) => {
  const problems: { sku: string; available: number; requested: number }[] = [];
  for (const item of cart.items) {
    const inv = item.variant.inventory;
    if (!item.variant.isActive || item.quantity > (inv?.availableQty ?? 0)) {
      problems.push({ sku: item.variant.sku, available: inv?.availableQty ?? 0, requested: item.quantity });
    }
  }
  if (problems.length > 0) {
    throw new ApiError(409, 'CART_INVALID', 'Some items in your bag are no longer available', { problems });
  }
};

// Public shape: prices re-resolved server-side on every read.
// `config` supplies the business-configured shipping rules (Settings);
// when omitted the environment defaults are used.
export const serializeCart = (
  cart: Cart,
  config?: { flatShippingPaise: number; freeShippingThresholdPaise: number },
) => {
  const items = cart.items.map((item) => {
    const currentUnitPaise = item.variant.pricePaise ?? item.variant.product.pricePaise;
    // Product media can now include VIDEO rows (mediaType). Cart/checkout
    // thumbnails must only ever receive IMAGE rows: prefer the image tagged
    // with this item's colour, then any IMAGE row. Legacy rows default to IMAGE.
    const productImages = item.variant.product.images;
    const imageRows = productImages.filter((i) => (i.mediaType ?? 'IMAGE') === 'IMAGE');
    const colorImage = imageRows.find((i) => i.colorName === item.variant.colorName);
    const image = (colorImage ?? imageRows[0])?.url ?? null;
    return {
      id: item.id,
      variantId: item.variantId,
      sku: item.variant.sku,
      productId: item.variant.productId,
      name: item.variant.product.name,
      slug: item.variant.product.slug,
      color: item.variant.colorName,
      size: item.variant.size ?? null,
      quantity: item.quantity,
      unitPrice: paiseToRupees(currentUnitPaise),
      image,
    };
  });
  const subtotalPaise = cart.items.reduce(
    (acc, item) => acc + (item.variant.pricePaise ?? item.variant.product.pricePaise) * item.quantity,
    0,
  );
  const flatShippingPaise = config?.flatShippingPaise ?? FLAT_SHIPPING_PAISE;
  const freeShippingThresholdPaise = config?.freeShippingThresholdPaise ?? FREE_SHIPPING_THRESHOLD_PAISE;
  const shipping = subtotalPaise >= freeShippingThresholdPaise ? 0 : flatShippingPaise;
  const taxPaise = 0;
  const totals = {
    subtotalPaise,
    shippingPaise: shipping,
    taxPaise,
    totalPaise: subtotalPaise + shipping + taxPaise,
  };
  return {
    id: cart.id,
    items,
    totalItems: items.reduce((a, i) => a + i.quantity, 0),
    subtotal: paiseToRupees(totals.subtotalPaise),
    shipping: paiseToRupees(totals.shippingPaise),
    total: paiseToRupees(totals.totalPaise),
  };
};
