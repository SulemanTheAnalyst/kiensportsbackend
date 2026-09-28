import { randomBytes } from 'crypto';

// Human-friendly order numbers: KIEN-2026-000001-A1B2C3
// Uniqueness: an in-process counter (deterministic) plus a random
// suffix for cross-instance entropy.
let counter = 0;

export const generateOrderNumber = (): string => {
  const year = new Date().getFullYear();
  counter = (counter + 1) % 100000;
  const rand = randomBytes(5).toString('hex').toUpperCase();
  return 'KIEN-' + year + '-' + String(counter).padStart(5, '0') + '-' + rand.slice(0, 6);
};

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('hex');
