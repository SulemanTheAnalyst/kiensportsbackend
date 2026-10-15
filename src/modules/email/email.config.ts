import { env, isProd } from '../../config/env';
import { logger } from '../../lib/logger';

// Email is optional infrastructure: the API must boot and serve checkout,
// auth and catalog even when Resend is not configured (local dev, CI).
// In production, missing configuration is reported loudly (safe logs +
// health endpoint) instead of crashing the process.

export interface EmailStatus {
  sendingConfigured: boolean;
  inboundConfigured: boolean;
  issues: string[];
}

export const emailStatus = (): EmailStatus => {
  const issues: string[] = [];
  if (!env.RESEND_API_KEY) issues.push('RESEND_API_KEY missing');
  if (!env.RESEND_WEBHOOK_SECRET) issues.push('RESEND_WEBHOOK_SECRET missing');
  if (!env.SUPPORT_EMAIL) issues.push('SUPPORT_EMAIL missing');
  return {
    sendingConfigured: !!env.RESEND_API_KEY,
    inboundConfigured: !!env.RESEND_WEBHOOK_SECRET,
    issues,
  };
};

// One-time production warning (values are never logged).
if (isProd && !env.RESEND_API_KEY) {
  logger.warn(
    'Transactional email is DISABLED in production: RESEND_API_KEY is not set. Order/contact/password-reset emails will not be sent.',
  );
}
if (isProd && !env.RESEND_WEBHOOK_SECRET) {
  logger.warn(
    'Resend inbound webhook is DISABLED in production: RESEND_WEBHOOK_SECRET is not set. Inbound email deliveries will be rejected.',
  );
}
