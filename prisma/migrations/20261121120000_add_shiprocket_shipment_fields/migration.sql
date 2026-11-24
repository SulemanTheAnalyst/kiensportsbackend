-- Shiprocket metadata is stored per shipment. No uniqueness constraints on
-- provider IDs because one order can be split into multiple parcels.
ALTER TABLE "Shipment"
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "shiprocketOrderId" TEXT,
  ADD COLUMN "shiprocketShipmentId" TEXT,
  ADD COLUMN "shiprocketAwbCode" TEXT,
  ADD COLUMN "shiprocketCourierId" INTEGER,
  ADD COLUMN "shiprocketCourierName" TEXT,
  ADD COLUMN "shiprocketLabelUrl" TEXT,
  ADD COLUMN "shiprocketTrackingUrl" TEXT,
  ADD COLUMN "shiprocketPickupId" TEXT,
  ADD COLUMN "shiprocketPickupScheduledAt" TIMESTAMP(3),
  ADD COLUMN "providerStatus" TEXT,
  ADD COLUMN "lastTrackingSyncAt" TIMESTAMP(3);

CREATE INDEX "Shipment_provider_shiprocketOrderId_idx"
  ON "Shipment"("provider", "shiprocketOrderId");
CREATE INDEX "Shipment_shiprocketAwbCode_idx"
  ON "Shipment"("shiprocketAwbCode");
