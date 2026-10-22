-- Additive product-media columns: ProductImage now stores both images and
-- videos (mediaType). Existing rows keep working: mediaType defaults to
-- 'IMAGE', and publicId/resourceType/format are nullable.
ALTER TABLE "ProductImage" ADD COLUMN "mediaType" TEXT NOT NULL DEFAULT 'IMAGE';
ALTER TABLE "ProductImage" ADD COLUMN "publicId" TEXT;
ALTER TABLE "ProductImage" ADD COLUMN "resourceType" TEXT;
ALTER TABLE "ProductImage" ADD COLUMN "format" TEXT;
