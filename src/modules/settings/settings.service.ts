import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import type { BusinessSettings } from '@prisma/client';

/**
 * Business configuration.
 *
 * The database is the authoritative source for operational settings; the
 * environment only contributes defaults (and remains the ONLY place where
 * credentials live - nothing secret is ever stored in BusinessSettings).
 *
 * A single singleton row (id = 'singleton') is created lazily on first write.
 * Reads are cached in-process for a short TTL so the hot checkout path does
 * not query the settings table on every request; the cache is invalidated
 * whenever an administrator saves changes.
 */

export const SETTINGS_SINGLETON_ID = 'singleton';
const CACHE_TTL_MS = 15_000;

export interface PricingConfig {
  flatShippingPaise: number;
  freeShippingThresholdPaise: number;
  codEnabled: boolean;
  prepaidEnabled: boolean;
  codMinOrderPaise: number;
  codMaxOrderPaise: number;
  outOfStockPurchaseRestricted: boolean;
}

export interface ResolvedSettings extends PricingConfig {
  brandName: string;
  legalName: string | null;
  logoUrl: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  websiteUrl: string;
  businessAddress: string | null;
  currency: string;
  timezone: string;
  taxRegistration: string | null;
  orderConfirmationEmails: boolean;
  businessOrderAlerts: boolean;
  preparationTimeDays: number;
  cancellationPolicyNote: string | null;
  dispatchNotifications: boolean;
  returnsProcessingNote: string | null;
  lowStockThresholdDefault: number;
  lowStockEmailAlerts: boolean;
  adjustmentReasonRequired: boolean;
  lowStockAlertEmails: string;
  paymentFailureAlerts: boolean;
  paymentSuccessAlerts: boolean;
  shippingPolicyNote: string | null;
  handlingTimeDays: number;
  returnWindowDays: number;
  returnsEnabled: boolean;
  returnRequestAlerts: boolean;
  businessNotificationEmail: string | null;
  newOrderAlerts: boolean;
  contactFormAlerts: boolean;
  cartActivityAlerts: boolean;
}

// Environment-derived defaults, used until an administrator saves changes.
// These mirror the previous hard-coded constants (Rs 99 flat shipping, free
// above Rs 2000) so behaviour is unchanged before configuration.
const defaults = (): ResolvedSettings => ({
  brandName: 'KIEN Sports',
  legalName: null,
  logoUrl: null,
  supportEmail: env.SUPPORT_EMAIL || null,
  supportPhone: null,
  websiteUrl: 'https://kiensports.com',
  businessAddress: null,
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  taxRegistration: null,
  orderConfirmationEmails: true,
  businessOrderAlerts: true,
  preparationTimeDays: 1,
  cancellationPolicyNote: null,
  dispatchNotifications: true,
  returnsProcessingNote: null,
  lowStockThresholdDefault: 5,
  lowStockEmailAlerts: true,
  outOfStockPurchaseRestricted: true,
  adjustmentReasonRequired: true,
  lowStockAlertEmails: '',
  codEnabled: true,
  prepaidEnabled: true,
  codMinOrderPaise: 0,
  codMaxOrderPaise: env.COD_MAX_ORDER_VALUE_RUPEES > 0 ? env.COD_MAX_ORDER_VALUE_RUPEES * 100 : 0,
  flatShippingPaise: 9900,
  freeShippingThresholdPaise: 200000,
  paymentFailureAlerts: true,
  paymentSuccessAlerts: true,
  shippingPolicyNote: null,
  handlingTimeDays: 2,
  returnWindowDays: 7,
  returnsEnabled: true,
  returnRequestAlerts: true,
  businessNotificationEmail: env.BUSINESS_NOTIFICATION_EMAIL || null,
  newOrderAlerts: true,
  contactFormAlerts: true,
  cartActivityAlerts: false,
});

let cache: { data: ResolvedSettings; at: number } | null = null;

const fromRow = (row: BusinessSettings): ResolvedSettings => ({
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
  codMinOrderPaise: row.codMinOrderPaise,
  codMaxOrderPaise: row.codMaxOrderPaise,
  flatShippingPaise: row.flatShippingPaise,
  freeShippingThresholdPaise: row.freeShippingThresholdPaise,
  paymentFailureAlerts: row.paymentFailureAlerts,
  paymentSuccessAlerts: row.paymentSuccessAlerts,
  shippingPolicyNote: row.shippingPolicyNote,
  handlingTimeDays: row.handlingTimeDays,
  returnWindowDays: row.returnWindowDays,
  returnsEnabled: row.returnsEnabled,
  returnRequestAlerts: row.returnRequestAlerts,
  businessNotificationEmail: row.businessNotificationEmail ?? env.BUSINESS_NOTIFICATION_EMAIL || null,
  newOrderAlerts: row.newOrderAlerts,
  contactFormAlerts: row.contactFormAlerts,
  cartActivityAlerts: row.cartActivityAlerts,
});

export const getSettings = async (force = false): Promise<ResolvedSettings> => {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const row = await prisma.businessSettings.findUnique({ where: { id: SETTINGS_SINGLETON_ID } });
  const data = row ? fromRow(row) : defaults();
  cache = { data, at: Date.now() };
  return data;
};

export const invalidateSettingsCache = () => {
  cache = null;
};

/** Hot-path subset used by cart/order pricing. */
export const getPricingConfig = async (): Promise<PricingConfig> => {
  const s = await getSettings();
  return {
    flatShippingPaise: s.flatShippingPaise,
    freeShippingThresholdPaise: s.freeShippingThresholdPaise,
    codEnabled: s.codEnabled,
    prepaidEnabled: s.prepaidEnabled,
    codMinOrderPaise: s.codMinOrderPaise,
    codMaxOrderPaise: s.codMaxOrderPaise,
    outOfStockPurchaseRestricted: s.outOfStockPurchaseRestricted,
  };
};

// Explicit reset hook for tests.
export const resetSettingsCacheForTests = () => {
  cache = null;
};
