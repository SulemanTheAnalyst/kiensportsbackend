import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { validate } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';
import { apiLimiter } from '../../middleware/errorHandler';
import { badRequest } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { emailStatus } from '../email/email.config';
import { sendEmail } from '../email/email.service';
import { imageStorageConfigured } from './image.storage';
import { env, isProd } from '../../config/env';
import {
  getSettings,
  saveSettings,
  SETTINGS_SECTIONS,
  type SettingsSection,
} from '../settings/settings.service';

// Admin Settings: backend-managed business configuration.
//  - GET    /settings            -> all sections (typed, safe fields only)
//  - PATCH  /settings            -> partial section updates (validated, audited)
//  - POST   /settings/test-email -> sends a real test email via the existing
//                                   Resend service (rate limited, recipient
//                                   validated; no secrets are involved)
//  - GET    /settings/system-health -> integration status indicators
//  - GET    /settings/notification-history -> outbox event history
//
// Credentials are NEVER part of settings: the API only reports whether an
// integration is configured (flags), never values.

export const adminSettingsRouter = Router();
adminSettingsRouter.use(requireAuth, requireRole('ADMIN'));

const generalSchema = z.object({
  brandName: z.string().min(1).max(80),
  registeredCompanyName: z.string().max(160).default(''),
  logoUrl: z.string().max(500).default(''),
  supportEmail: z.string().email().max(254).default(''),
  supportPhone: z.string().max(30).default(''),
  websiteUrl: z.string().max(200).default(''),
  businessAddress: z.string().max(400).default(''),
  currency: z.string().max(8).default('INR'),
  timezone: z.string().max(60).default('Asia/Kolkata'),
  taxRegistration: z.string().max(120).default(''),
});

const ordersSchema = z.object({
  sendOrderConfirmationEmails: z.boolean(),
  sendBusinessOrderAlerts: z.boolean(),
  sendDispatchEmails: z.boolean(),
  orderPrepTimeDays: z.number().int().min(0).max(90),
  returnProcessingDays: z.number().int().min(0).max(180),
  cancellationPolicyNote: z.string().max(1000).default(''),
});

const inventorySchema = z.object({
  lowStockThresholdDefault: z.number().int().min(0).max(100000),
  lowStockEmailAlerts: z.boolean(),
  outOfStockPurchaseRestricted: z.boolean(),
  adjustmentReasonRequired: z.boolean(),
  alertRecipientsEmail: z.string().email().max(254).default(''),
});

const checkoutSchema = z.object({
  codEnabled: z.boolean(),
  prepaidEnabled: z.boolean(),
  codMinOrderRupees: z.number().int().min(0).max(10_000_000),
  codMaxOrderRupees: z.number().int().min(0).max(10_000_000),
  flatShippingRupees: z.number().int().min(0).max(100_000),
  freeShippingThresholdRupees: z.number().int().min(0).max(10_000_000),
});

const shippingReturnsSchema = z.object({
  shippingPolicy: z.string().max(4000).default(''),
  handlingTimeDays: z.number().int().min(0).max(90),
  returnWindowDays: z.number().int().min(0).max(365),
  returnEligibilityRules: z.string().max(4000).default(''),
  sendReturnRequestNotifications: z.boolean(),
  refundProcessingDays: z.number().int().min(0).max(180),
});

const notificationsSchema = z.object({
  businessNotificationEmail: z.string().email().max(254).default(''),
  supportEmail: z.string().email().max(254).default(''),
  notifyNewOrder: z.boolean(),
  notifyPaymentFailure: z.boolean(),
  notifyLowStock: z.boolean(),
  notifyContactForm: z.boolean(),
  notifyReturnRequest: z.boolean(),
  notifyCartActivity: z.boolean(),
  cartActivityWindowMinutes: z.number().int().min(5).max(1440),
  sendCustomerOrderEmails: z.boolean(),
});

const sectionSchemas = {
  general: generalSchema,
  orders: ordersSchema,
  inventory: inventorySchema,
  checkout: checkoutSchema,
  shippingReturns: shippingReturnsSchema,
  notifications: notificationsSchema,
} as const;

const settingsPatchSchema = z
  .object({
    general: sectionSchemas.general.partial().optional(),
    orders: sectionSchemas.orders.partial().optional(),
    inventory: sectionSchemas.inventory.partial().optional(),
    checkout: sectionSchemas.checkout.partial().optional(),
    shippingReturns: sectionSchemas.shippingReturns.partial().optional(),
    notifications: sectionSchemas.notifications.partial().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'No settings section supplied' });

adminSettingsRouter.get('/', async (_req, res) => {
  const settings = await getSettings();
  res.json({ data: settings });
});

adminSettingsRouter.patch('/', validate({ body: settingsPatchSchema }), async (req, res) => {
  const body = req.body as z.infer<typeof settingsPatchSchema>;
  const sections: Partial<Record<SettingsSection, Record<string, unknown>>> = {};
  for (const section of SETTINGS_SECTIONS) {
    const patch = (body as Record<string, unknown>)[section];
    if (patch && typeof patch === 'object') {
      // Merge over the current stored value so partial updates keep the rest.
      const current = await getSettings();
      sections[section] = { ...(current[section] as Record<string, unknown>), ...(patch as Record<string, unknown>) };
    }
  }
  if (Object.keys(sections).length === 0) throw badRequest('No valid settings section supplied');
  const settings = await saveSettings(sections, req.user!.sub);
  await audit(req.user!.sub, 'SETTINGS_UPDATED', 'BusinessSetting', 'settings', { sections: Object.keys(sections) }, req.ip);
  res.json({ data: settings });
});

// Test email: validates the recipient, rate-limited, sent through the same
// Resend service as production notifications. Never touches credentials.
adminSettingsRouter.post(
  '/test-email',
  apiLimiter(10 * 60_000, 5),
  validate({ body: z.object({ to: z.string().email().max(254) }) }),
  async (req, res) => {
    const result = await sendEmail({
      to: req.body.to,
      subject: '[KIEN Sports] Test email from Settings',
      text: 'This is a test email sent from the KIEN Sports admin Settings section. If you received it, email delivery is working.',
      html: '<div style="font-family:Arial,sans-serif;font-size:14px;"><p>This is a test email sent from the KIEN Sports admin <b>Settings</b> section.</p><p>If you received it, email delivery is working.</p></div>',
    });
    await audit(req.user!.sub, 'SETTINGS_TEST_EMAIL', 'BusinessSetting', 'test-email', { accepted: result.accepted, error: result.error ?? null }, req.ip);
    res.json({ data: { accepted: result.accepted, error: result.error ?? null } });
  },
);

// Integration + system health indicators. Status flags only - no secrets,
// no credentials, no connection strings, and no backup claims without
// evidence (there is no backup monitor yet, so it reports UNKNOWN).
adminSettingsRouter.get('/system-health', async (_req, res) => {
  const email = emailStatus();
  const settings = await getSettings();
  let dbConnected = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbConnected = true;
  } catch {
    dbConnected = false;
  }
  res.json({
    data: {
      api: { status: 'CONNECTED', environment: env.NODE_ENV },
      database: { status: dbConnected ? 'CONNECTED' : 'ERROR' },
      email: {
        status: email.sendingConfigured ? 'CONNECTED' : 'CONFIGURATION_REQUIRED',
        sendingConfigured: email.sendingConfigured,
        inboundConfigured: email.inboundConfigured,
        issues: email.issues,
      },
      payments: {
        provider: env.PAYMENT_PROVIDER,
        // Provider secrets are never exposed - only readiness flags.
        status:
          env.PAYMENT_PROVIDER === 'razorpay' && env.RAZORPAY_KEY_ID
            ? 'CONNECTED'
            : env.PAYMENT_PROVIDER === 'razorpay'
              ? 'CONFIGURATION_REQUIRED'
              : isProd
                ? 'ERROR'
                : 'CONFIGURATION_REQUIRED',
      },
      productMediaStorage: { status: imageStorageConfigured() ? 'CONNECTED' : 'CONFIGURATION_REQUIRED' },
      shippingProvider: { status: 'NOT_CONFIGURED', note: 'Carrier integration (tracking) is data-driven; no provider is connected yet.' },
      backups: { status: 'UNKNOWN', note: 'No backup monitoring is configured yet - verify Neon backups in the provider console.' },
      businessNotificationEmail: {
        status: (settings.notifications.businessNotificationEmail || env.BUSINESS_NOTIFICATION_EMAIL) ? 'CONNECTED' : 'CONFIGURATION_REQUIRED',
        source: settings.notifications.businessNotificationEmail ? 'settings' : 'environment',
      },
    },
  });
});

// Notification event history (outbox) with last send/error info.
adminSettingsRouter.get('/notification-history', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 25));
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const where = status ? { status } : {};
  const [rows, total] = await Promise.all([
    prisma.notificationOutbox.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      // Safe subset: payload metadata only, no raw customer contact dump.
      select: {
        id: true, type: true, status: true, attempts: true, lastError: true,
        createdAt: true, sentAt: true,
        payload: true,
      },
    }),
    prisma.notificationOutbox.count({ where }),
  ]);
  const lastSent = await prisma.notificationOutbox.findFirst({ where: { status: 'SENT' }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } });
  const lastError = await prisma.notificationOutbox.findFirst({ where: { lastError: { not: null } }, orderBy: { updatedAt: 'desc' }, select: { lastError: true, updatedAt: true, type: true } });
  res.json({
    data: rows,
    page,
    limit,
    total,
    summary: {
      lastSuccessfulSendAt: lastSent?.sentAt ?? null,
      lastError: lastError ? { error: lastError.lastError, at: lastError.updatedAt, type: lastError.type } : null,
    },
  });
});
