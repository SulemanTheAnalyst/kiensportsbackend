-- KIEN Sports: business settings, coupon management.
-- Additive only: no existing table is dropped or recreated; existing data is
-- untouched. Apply with: npx prisma migrate deploy

-- ---------------------------------------------------------------- settings
CREATE TABLE "BusinessSettings" (
    "id"                          TEXT NOT NULL DEFAULT 'singleton',
    "brandName"                   TEXT NOT NULL DEFAULT 'KIEN Sports',
    "legalName"                   TEXT,
    "logoUrl"                     TEXT,
    "supportEmail"                TEXT,
    "supportPhone"                TEXT,
    "websiteUrl"                  TEXT NOT NULL DEFAULT 'https://kiensports.com',
    "businessAddress"             TEXT,
    "currency"                    TEXT NOT NULL DEFAULT 'INR',
    "timezone"                    TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "taxRegistration"             TEXT,
    "orderConfirmationEmails"     BOOLEAN NOT NULL DEFAULT true,
    "businessOrderAlerts"         BOOLEAN NOT NULL DEFAULT true,
    "preparationTimeDays"         INTEGER NOT NULL DEFAULT 1,
    "cancellationPolicyNote"      TEXT,
    "dispatchNotifications"       BOOLEAN NOT NULL DEFAULT true,
    "returnsProcessingNote"       TEXT,
    "lowStockThresholdDefault"    INTEGER NOT NULL DEFAULT 5,
    "lowStockEmailAlerts"         BOOLEAN NOT NULL DEFAULT true,
    "outOfStockPurchaseRestricted" BOOLEAN NOT NULL DEFAULT true,
    "adjustmentReasonRequired"    BOOLEAN NOT NULL DEFAULT true,
    "lowStockAlertEmails"         TEXT NOT NULL DEFAULT '',
    "codEnabled"                  BOOLEAN NOT NULL DEFAULT true,
    "prepaidEnabled"              BOOLEAN NOT NULL DEFAULT true,
    "codMinOrderPaise"            INTEGER NOT NULL DEFAULT 0,
    "codMaxOrderPaise"            INTEGER NOT NULL DEFAULT 0,
    "flatShippingPaise"           INTEGER NOT NULL DEFAULT 9900,
    "freeShippingThresholdPaise"  INTEGER NOT NULL DEFAULT 200000,
    "paymentFailureAlerts"        BOOLEAN NOT NULL DEFAULT true,
    "paymentSuccessAlerts"        BOOLEAN NOT NULL DEFAULT true,
    "shippingPolicyNote"          TEXT,
    "handlingTimeDays"            INTEGER NOT NULL DEFAULT 2,
    "returnWindowDays"            INTEGER NOT NULL DEFAULT 7,
    "returnsEnabled"              BOOLEAN NOT NULL DEFAULT true,
    "returnRequestAlerts"         BOOLEAN NOT NULL DEFAULT true,
    "businessNotificationEmail"   TEXT,
    "newOrderAlerts"              BOOLEAN NOT NULL DEFAULT true,
    "contactFormAlerts"           BOOLEAN NOT NULL DEFAULT true,
    "cartActivityAlerts"          BOOLEAN NOT NULL DEFAULT false,
    "updatedAt"                   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessSettings_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------- coupons
CREATE TABLE "Coupon" (
    "id"                     TEXT NOT NULL,
    "code"                   TEXT NOT NULL,
    "internalName"           TEXT NOT NULL,
    "publicDescription"      TEXT,
    "discountType"           TEXT NOT NULL,
    "discountValue"          INTEGER NOT NULL,
    "minimumOrderPaise"      INTEGER NOT NULL DEFAULT 0,
    "maximumDiscountPaise"    INTEGER,
    "startsAt"               TIMESTAMP(3),
    "expiresAt"              TIMESTAMP(3),
    "isActive"               BOOLEAN NOT NULL DEFAULT true,
    "isPublic"               BOOLEAN NOT NULL DEFAULT false,
    "promotionalHeadline"    TEXT,
    "campaignBadge"          TEXT,
    "displayPriority"        INTEGER NOT NULL DEFAULT 0,
    "totalUsageLimit"        INTEGER,
    "perCustomerUsageLimit"  INTEGER,
    "firstOrderOnly"         BOOLEAN NOT NULL DEFAULT false,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");

CREATE TABLE "CouponProduct" (
    "couponId"  TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "CouponProduct_pkey" PRIMARY KEY ("couponId", "productId")
);

CREATE INDEX "CouponProduct_productId_idx" ON "CouponProduct"("productId");

ALTER TABLE "CouponProduct" ADD CONSTRAINT "CouponProduct_couponId_fkey"
    FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CouponProduct" ADD CONSTRAINT "CouponProduct_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------- usage
-- One row per order that used a coupon. UNIQUE(orderId) makes redemption
-- exactly-once per order; status ACTIVE/RELEASED implements the documented
-- lifecycle (released on payment failure, expiry or cancellation).
CREATE TABLE "CouponUsage" (
    "id"             TEXT NOT NULL,
    "couponId"       TEXT NOT NULL,
    "orderId"        TEXT NOT NULL,
    "userId"         TEXT,
    "email"          TEXT NOT NULL,
    "discountPaise"  INTEGER NOT NULL,
    "status"         TEXT NOT NULL DEFAULT 'ACTIVE',
    "releaseReason"  TEXT,
    "releasedAt"     TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CouponUsage_orderId_key" ON "CouponUsage"("orderId");
CREATE INDEX "CouponUsage_couponId_status_idx" ON "CouponUsage"("couponId", "status");
CREATE INDEX "CouponUsage_userId_idx" ON "CouponUsage"("userId");

ALTER TABLE "CouponUsage" ADD CONSTRAINT "CouponUsage_couponId_fkey"
    FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CouponUsage" ADD CONSTRAINT "CouponUsage_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------- order snapshot
-- The applied coupon is snapshotted onto the order: historical totals stay
-- intact even if the coupon is later edited or disabled.
ALTER TABLE "Order" ADD COLUMN "couponId" TEXT,
                       ADD COLUMN "couponCode" TEXT;
CREATE INDEX "Order_couponId_idx" ON "Order"("couponId");
ALTER TABLE "Order" ADD CONSTRAINT "Order_couponId_fkey"
    FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;
