import { randomBytes } from 'crypto';

// Human-friendly, sequential-ish order numbers: KIEN-2026-000001
let counter = 0;

export const generateOrderNumber = (): string => {
  const year = new Date().getFullYear();
  counter = (counter + 1) % 100000;
  const rand = randomBytes(3).toString('hex').toUpperCase();
  return 'KIEN-' + year + '-' + Date.now().toString(36).toUpperCase().slice(-4) + rand.slice(0, 4);
};

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('hex');
