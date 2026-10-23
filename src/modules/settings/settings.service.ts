import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { DEFAULT_SHIPPING_RULE, type ShippingRule } from '../../lib/money';

// Backend-managed business configuration (admin Settings section).
//
// Design:
//  - One BusinessSetting row per section; `value` is the section JSON.
//  - Sections are merged over typed DEFAULTS, so a missing row, a new
//    field added later, or a partially-saved section all degrade safely
//    to the documented defaults (current production behaviour).
//  - Cached briefly (5s) because cart serialization and checkout call
//    getSettings() on every request; the cache is invalidated on write.
//  - SECRETS ARE NEVER STORED HERE. Credentials (Resend, Razorpay, DB,
//    storage) stay in environment variables; the settings API only
//    reports configured / not-configured status flags.
//
// IMPORTANT GUARANTEE: no setting can bypass payment verification or
// change the order state machine. Payment confirmation remains webhook-only
// and the COD/prepaid lifecycle is untouched; settings only configure
// eligibility, notifications, thresholds and display values.

export interface GeneralSettings {
  brandName: string;
  registeredCompanyName: string;
  logoUrl: string;
  supportEmail: string;
  supportPhone: string;
  websiteUrl: string;
  businessAddress: string;
  currency: string;
  timezone: string;
  taxRegistration: string;
}

export interface OrderSettings {
  sendOrderConfirmationEmails: boolean;
  sendBusinessOrderAlerts: boolean;
  sendDispatchEmails: boolean;
  orderPrepTimeDays: number;
  returnProcessingDays: number;
  // Display-only policy copy; the state machine is not configurable.
  cancellationPolicyNote: string;
}

export interface InventorySettings {
  lowStockThresholdDefault: number;
  lowStockEmailAlerts: boolean;
  outOfStockPurchaseRestricted: boolean;
  adjustmentReasonRequired: boolean;
  alertRecipientsEmail: string;
}

export interface CheckoutSettings {
  codEnabled: boolean;
  prepaidEnabled: boolean;
  codMinOrderRupees: number; // 0 = no minimum
  codMaxOrderRupees: number; // 0 = no cap (falls back to env cap when set)
  flatShippingRupees: number;
  freeShippingThresholdRupees: number;
}

export interface ShippingReturnsSettings {
  shippingPolicy: string;
  handlingTimeDays: number;
  returnWindowDays: number;
  returnEligibilityRules: string;
  sendReturnRequestNotifications: boolean;
  refundProcessingDays: number;
}

export interface NotificationSettings {
  businessNotificationEmail: string;
  supportEmail: string;
  notifyNewOrder: boolean;
  notifyPaymentFailure: boolean;
  notifyLowStock: boolean;
  notifyContactForm: boolean;
  notifyReturnRequest: boolean;
  notifyCartActivity: boolean;
  cartActivityWindowMinutes: number;
  sendCustomerOrderEmails: boolean;
}

export interface BusinessSettings {
  general: GeneralSettings;
  orders: OrderSettings;
  inventory: InventorySettings;
  checkout: CheckoutSettings;
  shippingReturns: ShippingReturnsSettings;
  notifications: NotificationSettings;
}

export const DEFAULT_SETTINGS: BusinessSettings = {
  general: {
    brandName: 'KIEN Sports',
    registeredCompanyName: '',
    logoUrl: '',
    supportEmail: '',
    supportPhone: '',
    websiteUrl: 'https://kiensports.com',
    businessAddress: '',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    taxRegistration: '',
  },
  orders: {
    sendOrderConfirmationEmails: true,
    sendBusinessOrderAlerts: true,
    sendDispatchEmails: true,
    orderPrepTimeDays: 2,
    returnProcessingDays: 7,
    cancellationPolicyNote: '',
  },
  inventory: {
    lowStockThresholdDefault: 5,
    lowStockEmailAlerts: false,
    outOfStockPurchaseRestricted: true,
    adjustmentReasonRequired: false,
    alertRecipientsEmail: '',
  },
  checkout: {
    codEnabled: true,
    prepaidEnabled: true,
    codMinOrderRupees: 0,
    codMaxOrderRupees: 0,
    flatShippingRupees: DEFAULT_SHIPPING_RULE.flatShippingPaise / 100,
    freeShippingThresholdRupees: DEFAULT_SHIPPING_RULE.freeShippingThresholdPaise / 100,
  },
  shippingReturns: {
    shippingPolicy: '',
    handlingTimeDays: 2,
    returnWindowDays: 7,
    returnEligibilityRules: '',
    sendReturnRequestNotifications: true,
    refundProcessingDays: 5,
  },
  notifications: {
    businessNotificationEmail: '',
    supportEmail: '',
    notifyNewOrder: true,
    notifyPaymentFailure: true,
    notifyLowStock: true,
    notifyContactForm: true,
    notifyReturnRequest: true,
    notifyCartActivity: true,
    cartActivityWindowMinutes: 30,
    sendCustomerOrderEmails: true,
  },
};

export type SettingsSection = keyof BusinessSettings;

export const SETTINGS_SECTIONS = Object.keys(DEFAULT_SETTINGS) as SettingsSection[];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Merge a stored section over the defaults, dropping unknown keys. Values
// with the wrong type fall back to the default (defensive: the admin UI
// validates, but the API contract must never break the storefront).
const mergeSection = <T extends Record<string, unknown>>(defaults: T, stored: unknown): T => {
  if (!isPlainObject(stored)) return { ...defaults };
  const out: Record<string, unknown> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const value = stored[key];
    if (value === undefined || value === null) continue;
    const defType = typeof defaults[key];
    if (defType === 'number' && typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (defType === 'boolean' && typeof value === 'boolean') out[key] = value;
    else if (defType === 'string' && typeof value === 'string') out[key] = value;
  }
  return out as T;
};

let cache: { at: number; settings: BusinessSettings } | null = null;
const CACHE_TTL_MS = 5_000;

export const getSettings = async (): Promise<BusinessSettings> => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.settings;
  const rows = await prisma.businessSetting.findMany().catch(() => [] as { key: string; value: unknown }[]);
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const settings = {} as BusinessSettings;
  for (const section of SETTINGS_SECTIONS) {
    (settings as Record<string, unknown>)[section] = mergeSection(
      DEFAULT_SETTINGS[section] as Record<string, unknown>,
      byKey.get(section),
    );
  }
  cache = { at: Date.now(), settings };
  return settings;
};

// Persist one or more sections (validated upstream by the route's zod
// schemas) and invalidate the cache. Audited by the caller.
export const saveSettings = async (
  sections: Partial<Record<SettingsSection, Record<string, unknown>>>,
  updatedBy: string,
): Promise<BusinessSettings> => {
  for (const [section, value] of Object.entries(sections)) {
    await prisma.businessSetting.upsert({
      where: { key: section },
      update: { value: value as never, updatedBy },
      create: { key: section, value: value as never, updatedBy },
    });
  }
  cache = null;
  logger.info({ sections: Object.keys(sections) }, 'Business settings updated');
  return getSettings();
};

// ---- Derived helpers used across the backend ----

// The shipping rule the backend ENFORCES (cart, quote, checkout, coupons).
export const getShippingRule = async (): Promise<ShippingRule> => {
  const { checkout } = await getSettings();
  return {
    flatShippingPaise: Math.max(0, Math.round(checkout.flatShippingRupees * 100)),
    freeShippingThresholdPaise: Math.max(0, Math.round(checkout.freeShippingThresholdRupees * 100)),
  };
};

// Effective COD eligibility window (whole rupees). 0 = no bound on that side.
// The environment cap (COD_MAX_ORDER_VALUE_RUPEES) still applies as a
// hard ceiling when set: the stricter of the two wins.
export const getCodBounds = async (envCapRupees: number) => {
  const { checkout } = await getSettings();
  return {
    minRupees: Math.max(0, Math.round(checkout.codMinOrderRupees)),
    maxRupees: Math.max(0, Math.round(checkout.codMaxOrderRupees)),
    envCapRupees,
    effectiveMaxRupees:
      checkout.codMaxOrderRupees > 0 && envCapRupees > 0
        ? Math.min(checkout.codMaxOrderRupees, envCapRupees)
        : Math.max(checkout.codMaxOrderRupees, envCapRupees),
  };
};
