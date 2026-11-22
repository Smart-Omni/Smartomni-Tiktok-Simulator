-- The simulator no longer has an ON_HOLD status (DECISIONS H1, H10): paid orders are AWAITING_SHIPMENT at once.
-- Orders still held when this runs are released now. Their TO_FULFILL package cannot be created in SQL (package ids are
-- derived in code), so FulfillmentService.repairMissingPackages() creates it at startup (DECISIONS H11).
-- OrderAudit rows and stored webhook payloads keep their history (DECISIONS H12).
UPDATE "Order" SET "status" = 'AWAITING_SHIPMENT' WHERE "status" = 'ON_HOLD';
UPDATE "OrderLine" SET "displayStatus" = 'AWAITING_SHIPMENT' WHERE "displayStatus" = 'ON_HOLD';

ALTER TABLE "Order" DROP COLUMN "releaseAt";
ALTER TABLE "Order" DROP COLUMN "isOnHold";
