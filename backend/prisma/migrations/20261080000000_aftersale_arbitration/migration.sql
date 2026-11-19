-- AlterTable
ALTER TABLE "AftersaleRequest" ADD COLUMN "arbitrationStatus" TEXT NOT NULL DEFAULT 'NO_ARBITRATION',
ADD COLUMN "sellerProposedReturnType" TEXT;

