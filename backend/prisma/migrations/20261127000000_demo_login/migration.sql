-- Demo sign-in accounts. Filled by the seed.
ALTER TABLE "Seller" ADD COLUMN "loginEmail" TEXT, ADD COLUMN "passwordHash" TEXT;
ALTER TABLE "Buyer" ADD COLUMN "loginEmail" TEXT, ADD COLUMN "passwordHash" TEXT;
CREATE UNIQUE INDEX "Seller_loginEmail_key" ON "Seller"("loginEmail");
CREATE UNIQUE INDEX "Buyer_loginEmail_key" ON "Buyer"("loginEmail");
