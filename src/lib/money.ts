// All internal money is INTEGER PAISE. The public API speaks INTEGER RUPEES
// to remain drop-in compatible with the existing KIEN frontend (price: 4999).

export const rupeesToPaise = (rupees: number): number => {
  if (!Number.isInteger(rupees)) {
    throw new Error('Rupee amounts must be integers, got ' + rupees);
  }
  return rupees * 100;
};

export const paiseToRupees = (paise: number): number => Math.trunc(paise / 100);

// Shipping rule currently displayed by the frontend checkout:
// free above Rs 2000 subtotal, otherwise flat Rs 99.
export const FREE_SHIPPING_THRESHOLD_PAISE = 200000;
export const FLAT_SHIPPING_PAISE = 9900;

export const shippingPaise = (subtotalPaise: number): number =>
  subtotalPaise >= FREE_SHIPPING_THRESHOLD_PAISE ? 0 : FLAT_SHIPPING_PAISE;

export const computeTotals = (lines: { unitPricePaise: number; quantity: number }[]) => {
  const subtotalPaise = lines.reduce((acc, l) => acc + l.unitPricePaise * l.quantity, 0);
  const shipping = shippingPaise(subtotalPaise);
  // DTC intra-state GST can be added here later; kept 0 for launch.
  const taxPaise = 0;
  return {
    subtotalPaise,
    shippingPaise: shipping,
    taxPaise,
    totalPaise: subtotalPaise + shipping + taxPaise,
  };
};
