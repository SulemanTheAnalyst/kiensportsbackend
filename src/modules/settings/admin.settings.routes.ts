import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { env, isProd } from '../../config/env';
import { badRequest } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';
import { apiLimiter } from '../../middleware/errorHandler';
import { audit } from '../../lib/audit';
import { sendEmail } from '../email/email.service';
import { emailStatus } from '../email/email.config';
import { imageStorageConfigured } from '../admin/image.storage';
import {
  getSettings,
  invalidateSettingsCache,
  SETTINGS_SINGLETON_ID,
} from './settings.service';

/**
 * Business configuration centre (admin).
 *
 * GET/PUT /admin/settings - the singleton BusinessSettings record. PUT is
 * whitelisted-field-only (zod), audit-logged, and never touches credentials.
 * POST /admin/settings/test-email - sends one real test email through the
 * existing Resend service; recipient validated; rate limited.
 * GET /admin/settings/health - operational status of every integration.
 * Statuses: 'connected' | 'configuration_required' | 'error' | 'not_configured'.
 * GET /admin/settings/notifications - recent outbox history (no payloads).
 */

export const adminSettingsRouter = Router();
adminSettingsRouter.use(requireAuth, requireRole('ADMIN'));

// ---- Settings read/write ----

const settingsBodySchema = z.object({
  brandName: z.string().trim().min(1).max(80).optional(),
  legalName: z.string().trim().max(160).optional().nullable(),
  logoUrl: z.string().trim().url().max(500).optional().nullable(),
  supportEmail: z.string().trim().email().max(160).optional().nullable(),
  supportPhone: z.string().trim().max(32).optional().nullable(),
  websiteUrl: z.string().trim().url().max(200).optional(),
  businessAddress: z.string().trim().max(500).optional().nullable(),
  currency: z.enum(['INR']).optional(),
  timezone: z.string().trim().max(64).optional(),
  taxRegistration: z.string().trim().max(64).optional().nullable(),
  orderConfirmationEmails: z.boolean().optional(),
  businessOrderAlerts: z.boolean().optional(),
  preparationTimeDays: z.number().int().min(0).max(30).optional(),
  cancellationPolicyNote: z.string().trim().max(1000).optional().nullable(),
  dispatchNotifications: z.boolean().optional(),
  returnsProcessingNote: z.string().trim().max(1000).optional().nullable(),
  lowStockThresholdDefault: z.number().int().min(0).max(10000).optional(),
  lowStockEmailAlerts: z.boolean().optional(),
  outOfStockPurchaseRestricted: z.boolean().optional(),
  adjustmentReasonRequired: z.boolean().optional(),
  lowStockAlertEmails: z.string().trim().max(500).optional(),
  codEnabled: z.boolean().optional(),
  prepaidEnabled: z.boolean().optional(),
  codMinOrderRupees: z.number().int().min(0).max(10000000).optional(),
  codMaxOrderRupees: z.number().int().min(0).max(10000000).optional(),
  flatShippingRupees: z.number().int().min(0).max(100000).optional(),
  freeShippingThresholdRupees: z.number().int().min(0).max(10000000).optional(),
  paymentFailureAlerts: z.boolean().optional(),
  paymentSuccessAlerts: z.boolean().optional(),
  shippingPolicyNote: z.string().trim().max(2000).optional().nullable(),
  handlingTimeDays: z.number().int().min(0).max(30).optional(),
  returnWindowDays: z.number().int().min(0).max(365).optional(),
  returnsEnabled: z.boolean().optional(),
  returnRequestAlerts: z.boolean().optional(),
  businessNotificationEmail: z.string().trim().email().max(160).optional().nullable(),
  newOrderAlerts: z.boolean().optional(),
  contactFormAlerts: z.boolean().optional(),
  cartActivityAlerts: z.boolean().optional(),
});

// The admin API speaks rupees for money settings (consistent with every other
// admin endpoint); storage is paise.
const rupeesToPaise = (r: number) => r * 100;
const paiseToRupees = (p: number) => p / 100;

adminSettingsRouter.get('/settings', async (_req, res) => {
  const row = await prisma.businessSettings.findUnique({ where: { id: SETTINGS_SINGLETON_ID } });
  const defaults = await getSettings();
  // No secrets are stored in or returned from settings - only display/config
  // values. When nothing has been saved yet, the resolved environment
  // defaults are returned (flagged saved: false).
  const data = row
    ? {
        brandName: row.brandName,
        legalName: row.legalName,
        logoUrl: row.logoUrl,
        supportEmail: row.supportEmail,
        supportPhone: row.supportPhone,
        websiteUrl: row.websiteUrl,
        businessAddress: row.businessAddress,
        currency: row.currency,
        timezone: row.timezone,
        taxRegistration: row.taxRegistration,
        orderConfirmationEmails: row.orderConfirmationEmails,
        businessOrderAlerts: row.businessOrderAlerts,
        preparationTimeDays: row.preparationTimeDays,
        cancellationPolicyNote: row.cancellationPolicyNote,
        dispatchNotifications: row.dispatchNotifications,
        returnsProcessingNote: row.returnsProcessingNote,
        lowStockThresholdDefault: row.lowStockThresholdDefault,
        lowStockEmailAlerts: row.lowStockEmailAlerts,
        outOfStockPurchaseRestricted: row.outOfStockPurchaseRestricted,
        adjustmentReasonRequired: row.adjustmentReasonRequired,
        lowStockAlertEmails: row.lowStockAlertEmails,
        codEnabled: row.codEnabled,
        prepaidEnabled: row.prepaidEnabled,
        codMinOrderRupees: paiseToRupees(row.codMinOrderPaise),
        codMaxOrderRupees: paiseToRupees(row.codMaxOrderPaise),
        flatShippingRupees: paiseToRupees(row.flatShippingPaise),
        freeShippingThresholdRupees: paiseToRupees(row.freeShippingThresholdPaise),
        paymentFailureAlerts: row.paymentFailureAlerts,
        paymentSuccessAlerts: row.paymentSuccessAlerts,
        shippingPolicyNote: row.shippingPolicyNote,
        handlingTimeDays: row.handlingTimeDays,
        returnWindowDays: row.returnWindowDays,
        returnsEnabled: row.returnsEnabled,
        returnRequestAlerts: row.returnRequestAlerts,
        businessNotificationEmail: row.businessNotificationEmail,
        newOrderAlerts: row.newOrderAlerts,
        contactFormAlerts: row.contactFormAlerts,
        cartActivityAlerts: row.cartActivityAlerts,
        saved: true,
        updatedAt: row.updatedAt,
      }
    : {
        brandName: defaults.brandName,
        legalName: null,
        logoUrl: null,
        supportEmail: defaults.supportEmail,
        supportPhone: null,
        websiteUrl: defaults.websiteUrl,
        businessAddress: null,
        currency: defaults.currency,
        timezone: defaults.timezone,
        taxRegistration: null,
        orderConfirmationEmails: defaults.orderConfirmationEmails,
        businessOrderAlerts: defaults.businessOrderAlerts,
        preparationTimeDays: defaults.preparationTimeDays,
        cancellationPolicyNote: null,
        dispatchNotifications: defaults.dispatchNotifications,
        returnsProcessingNote: null,
        lowStockThresholdDefault: defaults.lowStockThresholdDefault,
        lowStockEmailAlerts: defaults.lowStockEmailAlerts,
        outOfStockPurchaseRestricted: defaults.outOfStockPurchaseRestricted,
        adjustmentReasonRequired: defaults.adjustmentReasonRequired,
        lowStockAlertEmails: defaults.lowStockAlertEmails,
        codEnabled: defaults.codEnabled,
        prepaidEnabled: defaults.prepaidEnabled,
        codMinOrderRupees: paiseToRupees(defaults.codMinOrderPaise),
        codMaxOrderRupees: paiseToRupees(defaults.codMaxOrderPaise),
        flatShippingRupees: paiseToRupees(defaults.flatShippingPaise),
        freeShippingThresholdRupees: paiseToRupees(defaults.freeShippingThresholdPaise),
        paymentFailureAlerts: defaults.paymentFailureAlerts,
        paymentSuccessAlerts: defaults.paymentSuccessAlerts,
        shippingPolicyNote: null,
        handlingTimeDays: defaults.handlingTimeDays,
        returnWindowDays: defaults.returnWindowDays,
        returnsEnabled: defaults.returnsEnabled,
        returnRequestAlerts: defaults.returnRequestAlerts,
        businessNotificationEmail: defaults.businessNotificationEmail,
        newOrderAlerts: defaults.newOrderAlerts,
        contactFormAlerts: defaults.contactFormAlerts,
        cartActivityAlerts: defaults.cartActivityAlerts,
        saved: false,
        updatedAt: null,
      };
  res.json({ data });
});

adminSettingsRouter.put(
  '/settings',
  validate({ body: settingsBodySchema }),
  async (req, res) => {
    const b = req.body as z.infer<typeof settingsBodySchema>;
    // Cross-field sanity: the free-shipping threshold and fee are independent
    // (a high fee with a low threshold is a valid business choice), but a
    // COD minimum above the maximum is never valid.
    if (
      b.codMinOrderRupees !== undefined &&
      b.codMaxOrderRupees !== undefined &&
      b.codMaxOrderRupees > 0 &&
      b.codMinOrderRupees > b.codMaxOrderRupees
    ) {
      throw badRequest('The COD minimum order value cannot exceed the COD maximum.');
    }

    const data: Record<string, unknown> = {};
    const map: [keyof typeof b, string, boolean?][] = [
      ['brandName', 'brandName'],
      ['legalName', 'legalName'],
      ['logoUrl', 'logoUrl'],
      ['supportEmail', 'supportEmail'],
      ['supportPhone', 'supportPhone'],
      ['websiteUrl', 'websiteUrl'],
      ['businessAddress', 'businessAddress'],
      ['currency', 'currency'],
      ['timezone', 'timezone'],
      ['taxRegistration', 'taxRegistration'],
      ['orderConfirmationEmails', 'orderConfirmationEmails'],
      ['businessOrderAlerts', 'businessOrderAlerts'],
      ['preparationTimeDays', 'preparationTimeDays'],
      ['cancellationPolicyNote', 'cancellationPolicyNote'],
      ['dispatchNotifications', 'dispatchNotifications'],
      ['returnsProcessingNote', 'returnsProcessingNote'],
      ['lowStockThresholdDefault', 'lowStockThresholdDefault'],
      ['lowStockEmailAlerts', 'lowStockEmailAlerts'],
      ['outOfStockPurchaseRestricted', 'outOfStockPurchaseRestricted'],
      ['adjustmentReasonRequired', 'adjustmentReasonRequired'],
      ['lowStockAlertEmails', 'lowStockAlertEmails'],
      ['codEnabled', 'codEnabled'],
      ['prepaidEnabled', 'prepaidEnabled'],
      ['paymentFailureAlerts', 'paymentFailureAlerts'],
      ['paymentSuccessAlerts', 'paymentSuccessAlerts'],
      ['shippingPolicyNote', 'shippingPolicyNote'],
      ['handlingTimeDays', 'handlingTimeDays'],
      ['returnWindowDays', 'returnWindowDays'],
      ['returnsEnabled', 'returnsEnabled'],
      ['returnRequestAlerts', 'returnRequestAlerts'],
      ['businessNotificationEmail', 'businessNotificationEmail'],
      ['newOrderAlerts', 'newOrderAlerts'],
      ['contactFormAlerts', 'contactFormAlerts'],
      ['cartActivityAlerts', 'cartActivityAlerts'],
    ];
    for (const [key, field] of map) {
      if (b[key] !== undefined) data[field] = b[key];
    }
    if (b.codMinOrderRupees !== undefined) data.codMinOrderPaise = rupeesToPaise(b.codMinOrderRupees);
    if (b.codMaxOrderRupees !== undefined) data.codMaxOrderPaise = rupeesToPaise(b.codMaxOrderRupees);
    if (b.flatShippingRupees !== undefined) data.flatShippingPaise = rupeesToPaise(b.flatShippingRupees);
    if (b.freeShippingThresholdRupees !== undefined) {
      data.freeShippingThresholdPaise = rupeesToPaise(b.freeShippingThresholdRupees);
    }

    // Upsert keeps the singleton; validation happened above.
    const row = await prisma.businessSettings.upsert({
      where: { id: SETTINGS_SINGLETON_ID },
      create: { id: SETTINGS_SINGLETON_ID, ...data },
      update: data,
    });
    invalidateSettingsCache();
    // Audit the changed fields only (values may contain a business address;
    // that is operational data an admin can see in the audit log).
    await audit(req.user!.sub, 'SETTINGS_UPDATED', 'BusinessSettings', SETTINGS_SINGLETON_ID, { fields: Object.keys(data) }, req.ip);
    res.json({ data: { updatedAt: row.updatedAt, savedFields: Object.keys(data) } });
  },
);

// ---- Test email ----

adminSettingsRouter.post(
  '/settings/test-email',
  validate({ body: z.object({ to: z.string().trim().email().max(160) }) }),
  apiLimiter(60_000, 3),
  async (req, res) => {
    const to = req.body.to as string;
    if (!emailStatus().sendingConfigured) {
      res.status(503).json({
        error: { code: 'EMAIL_NOT_CONFIGURED', message: 'Resend is not configured on the server (RESEND_API_KEY missing). Set it up before testing.' },
      });
      return;
    }
    const result = await sendEmail({
      to,
      subject: 'KIEN Sports - test email',
      text: 'This is a test email from the KIEN Sports admin panel. Delivery is working.',
      html: '<p>This is a <strong>test email</strong> from the KIEN Sports admin panel. Delivery is working.</p>',
    });
    await audit(req.user!.sub, 'SETTINGS_TEST_EMAIL', 'BusinessSettings', SETTINGS_SINGLETON_ID, { accepted: result.accepted }, req.ip);
    if (!result.accepted) {
      res.status(502).json({
        error: { code: 'EMAIL_SEND_FAILED', message: 'The email provider rejected the send. Check the server logs.' },
      });
      return;
    }
    res.json({ data: { accepted: true, note: 'Accepted by the email provider (delivery confirmation arrives separately).' } });
  },
);

// ---- System health ----

adminSettingsRouter.get('/settings/health', async (_req, res) => {
  let database: 'connected' | 'error' = 'connected';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = 'error';
  }

  const emailConfigured = emailStatus().sendingConfigured;
  const razorpayConfigured = isProd ? Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) : env.PAYMENT_PROVIDER === 'razorpay' ? Boolean(env.RAZORPAY_KEY_ID) : true;
  const storage = imageStorageConfigured();
  const whatsapp = env.WHATSAPP_ENABLED === 'true' && Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);

  res.json({
    data: {
      api: 'connected',
      database,
      email: emailConfigured ? 'connected' : 'configuration_required',
      payments: {
        provider: env.PAYMENT_PROVIDER,
        // The mock gateway is refused in production; report honestly.
        status: env.PAYMENT_PROVIDER === 'mock' && isProd ? 'configuration_required' : razorpayConfigured ? 'connected' : 'configuration_required',
      },
      productMediaStorage: storage ? 'connected' : 'not_configured',
      whatsapp: whatsapp ? 'connected' : 'not_configured',
      // No backup monitoring is implemented: never claim a backup exists.
      backups: 'not_configured',
      nodeEnv: env.NODE_ENV,
    },
  });
});

// ---- Notification event history ----

adminSettingsRouter.get('/settings/notifications', async (_req, res) => {
  const [recent, lastSent, lastFailed] = await Promise.all([
    prisma.notificationOutbox.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      // Payloads contain customer contact details - never expose them here.
      select: { id: true, type: true, dedupeKey: true, status: true, attempts: true, lastError: true, createdAt: true, sentAt: true },
    }),
    prisma.notificationOutbox.findFirst({ where: { status: 'SENT' }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } }),
    prisma.notificationOutbox.findFirst({ where: { status: 'FAILED' }, orderBy: { updatedAt: 'desc' }, select: { lastError: true, updatedAt: true, type: true } }),
  ]);
  res.json({
    data: {
      events: recent,
      lastSuccessfulSendAt: lastSent?.sentAt ?? null,
      lastError: lastFailed ? { type: lastFailed.type, error: lastFailed.lastError, at: lastFailed.updatedAt } : null,
    },
  });
});
