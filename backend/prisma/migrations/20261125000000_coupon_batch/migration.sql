-- Phase 09c: single-use promo code batches. Codes of one batch share batchId; NULL = a single (09a) voucher.
ALTER TABLE "Coupon" ADD COLUMN "batchId" TEXT;
CREATE INDEX "Coupon_shopId_batchId_idx" ON "Coupon"("shopId", "batchId");
