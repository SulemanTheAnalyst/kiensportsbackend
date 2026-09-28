import { describe, expect, it } from 'vitest';
import { generateOrderNumber, randomToken } from '../../src/lib/ids';

describe('order numbers', () => {
  it('uses the KIEN-<year>- prefix format', () => {
    const n = generateOrderNumber();
    expect(n).toMatch(/^KIEN-\d{4}-/);
    expect(n.length).toBeGreaterThan(12);
  });

  it('generates unique values', () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateOrderNumber()));
    expect(seen.size).toBe(500);
  });
});

describe('randomToken', () => {
  it('produces hex tokens of expected length', () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces unique values', () => {
    const seen = new Set(Array.from({ length: 200 }, () => randomToken(16)));
    expect(seen.size).toBe(200);
  });
});
