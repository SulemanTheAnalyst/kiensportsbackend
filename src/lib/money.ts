// All internal money is INTEGER PAISE. The public API speaks INTEGER RUPEES
// to remain drop-in compatible with the existing KIEN frontend (price: 4999).

export const rupeesToPaise = (rupees: number): number => {
  if (!Number.isInteger(rupees)) {
    throw new Error('Rupee amounts must be integers, got ' + rupees);
  }
  return rupees * 100;
};

export const paiseToRupees = (paise: number): number => Math.trunc(paise / 100);

// ---- Shipping ----
// The launch rule (free above Rs 2000 subtotal, otherwise flat Rs 99) is the
// DEFAULT. The live values are configured by the administrator in Settings
// (Settings -> Payments & Checkout) and served from the backend settings
// service; the frontend always displays what the backend enforces.
export interface ShippingRule {
  flatShippingPaise: number;
  freeShippingThresholdPaise: number;
}

export const DEFAULT_SHIPPING_RULE: ShippingRule = {
  flatShippingPaise: 9900,
  freeShippingThresholdPaise: 200000,
};

// Shipping is evaluated on the PRE-DISCOUNT merchandise subtotal (the same
// rule the storefront has always displayed). A FREE_SHIPPING coupon can
// zero the shipping charge itself.
export const shippingPaiseFor = (subtotalPaise: number, rule: ShippingRule = DEFAULT_SHIPPING_RULE): number =>
  subtotalPaise >= rule.freeShippingThresholdPaise ? 0 : rule.flatShippingPaise;

// Backwards-compatible helper for the previous constant-based call sites.
export const FREE_SHIPPING_THRESHOLD_PAISE = DEFAULT_SHIPPING_RULE.freeShippingThresholdPaise;
export const FLAT_SHIPPING_PAISE = DEFAULT_SHIPPING_RULE.flatShippingPaise;
export const shippingPaise = (subtotalPaise: number): number => shippingPaiseFor(subtotalPaise);

export const computeTotals = (
  lines: { unitPricePaise: number; quantity: number }[],
  rule: ShippingRule = DEFAULT_SHIPPING_RULE,
) => {
  const subtotalPaise = lines.reduce((acc, l) => acc + l.unitPricePaise * l.quantity, 0);
  const shipping = shippingPaiseFor(subtotalPaise, rule);
  // DTC intra-state GST can be added here later; kept 0 for launch.
  const taxPaise = 0;
  return {
    subtotalPaise,
    shippingPaise: shipping,
    taxPaise,
    totalPaise: subtotalPaise + shipping + taxPaise,
  };
};

// ---- Coupon-aware totals ----
// Discounts are always calculated on the backend from server-side prices.
// `discountPaise` must already be clamped to [0, subtotalPaise] by the coupon
// service. Total can never go negative.
export const applyDiscountToTotals = (
  totals: { subtotalPaise: number; shippingPaise: number; taxPaise: number },
  discountPaise: number,
) => {
  const safeDiscount = Math.max(0, Math.min(discountPaise, totals.subtotalPaise));
  const totalPaise = Math.max(0, totals.subtotalPaise - safeDiscount + totals.shippingPaise + totals.taxPaise);
  return {
    ...totals,
    discountPaise: safeDiscount,
    totalPaise,
  };
};
