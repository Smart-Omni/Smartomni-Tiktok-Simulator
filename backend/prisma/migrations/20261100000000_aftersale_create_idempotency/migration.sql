-- AlterTable
ALTER TABLE "AftersaleRequest" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AftersaleRequest_shopId_idempotencyKey_key" ON "AftersaleRequest"("shopId", "idempotencyKey");
