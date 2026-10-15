import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  API_BASE_PATH: z.string().default('/api/v1'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  BCRYPT_COST: z.coerce.number().default(12),
  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  PAYMENT_WEBHOOK_SECRET: z.string().default('change-me'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  // ---- Email (Resend) ----
  // All optional: the app boots without email so local development and CI do
  // not require a Resend account. Production health exposes missing config.
  RESEND_API_KEY: z.string().optional().default(''),
  // Svix signing secret (whsec_...) shown once when the webhook is created in
  // the Resend dashboard. NOT the same value as RESEND_API_KEY.
  RESEND_WEBHOOK_SECRET: z.string().optional().default(''),
  EMAIL_FROM: z.string().default('KIEN Sports <no-reply@kiensports.com>'),
  EMAIL_REPLY_TO: z.string().optional().default(''),
  SUPPORT_EMAIL: z.string().default('support@kiensports.com'),
  BUSINESS_NOTIFICATION_EMAIL: z.string().optional().default(''),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast at boot; never log values, only the missing keys.
  const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  throw new Error('Invalid environment configuration. Check: ' + keys);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
