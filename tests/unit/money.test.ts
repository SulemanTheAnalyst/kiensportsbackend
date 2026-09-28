import { describe, expect, it } from 'vitest';
import {
  rupeesToPaise,
  paiseToRupees,
  shippingPaise,
  computeTotals,
  FREE_SHIPPING_THRESHOLD_PAISE,
} from '../../src/lib/money';

describe('money', () => {
  it('converts rupees to paise', () => {
    expect(rupeesToPaise(4999)).toBe(499900);
    expect(rupeesToPaise(0)).toBe(0);
  });

  it('rejects non-integer rupee amounts', () => {
    expect(() => rupeesToPaise(49.99)).toThrow();
  });

  it('converts paise back to rupees (truncating)', () => {
    expect(paiseToRupees(499900)).toBe(4999);
    expect(paiseToRupees(9950)).toBe(99);
  });

  it('round-trips frontend prices exactly', () => {
    for (const price of [1999, 3499, 4999]) {
      expect(paiseToRupees(rupeesToPaise(price))).toBe(price);
    }
  });
});

describe('shipping rules (must match the frontend checkout display)', () => {
  it('charges flat Rs 99 below Rs 2000 subtotal', () => {
    expect(shippingPaise(199900)).toBe(9900);
  });

  it('is free at and above Rs 2000 subtotal', () => {
    expect(shippingPaise(FREE_SHIPPING_THRESHOLD_PAISE)).toBe(0);
    expect(shippingPaise(499900)).toBe(0);
  });
});

describe('computeTotals', () => {
  it('sums line items and applies the shipping rule', () => {
    const totals = computeTotals([
      { unitPricePaise: 499900, quantity: 1 },
      { unitPricePaise: 199900, quantity: 2 },
    ]);
    // subtotal 899700 >= 2000 -> free shipping
    expect(totals.subtotalPaise).toBe(899700);
    expect(totals.shippingPaise).toBe(0);
    expect(totals.totalPaise).toBe(899700);
  });

  it('adds Rs 99 shipping when subtotal is below the threshold', () => {
    const totals = computeTotals([{ unitPricePaise: 199900, quantity: 1 }]);
    expect(totals.shippingPaise).toBe(9900);
    expect(totals.totalPaise).toBe(209800);
  });
});
