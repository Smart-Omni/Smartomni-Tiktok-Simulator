-- AlterTable
ALTER TABLE "Product" ADD COLUMN "categoryId" TEXT,
ADD COLUMN "brandId" TEXT,
ADD COLUMN "mainImages" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "packageWeight" JSONB,
ADD COLUMN "packageDimensions" JSONB,
ADD COLUMN "productAttributes" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "isCodAllowed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "externalProductId" TEXT;
