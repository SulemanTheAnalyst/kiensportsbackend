-- Product media: extend ProductImage so it can represent images AND videos.
-- Additive only: every new column is nullable or carries a default, so
-- existing rows (image-only products) remain valid and untouched.
ALTER TABLE "ProductImage" ADD COLUMN "mediaType" TEXT NOT NULL DEFAULT 'IMAGE';
ALTER TABLE "ProductImage" ADD COLUMN "publicId" TEXT;
ALTER TABLE "ProductImage" ADD COLUMN "format" TEXT;
ALTER TABLE "ProductImage" ADD COLUMN "width" INTEGER;
ALTER TABLE "ProductImage" ADD COLUMN "height" INTEGER;
ALTER TABLE "ProductImage" ADD COLUMN "durationSeconds" INTEGER;
