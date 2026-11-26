-- Every shop keeps exactly ONE warehouse: its default one (DECISIONS SW-1, SW-2).
-- Stock of the other warehouses is added to it, orders reserved in them are re-pointed (so a later cancel restores stock),
-- then those warehouses are removed. Their InventoryChange rows go with them (ON DELETE CASCADE); the kept warehouse gets
-- one ADMIN row per SKU whose quantity changed, so its before/after chain stays unbroken. SKU totals do not change.
-- Stored webhook payloads keep their history, and no webhook is queued: clients re-read the warehouses and stock.
BEGIN;

LOCK TABLE "Warehouse", "InventoryLevel", "InventoryChange", "Order" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "_KeptWarehouse" AS
SELECT DISTINCT ON ("shopId") "shopId", "id" FROM "Warehouse" ORDER BY "shopId", "isDefault" DESC, "code", "id";

-- A merged quantity above the per-warehouse limit of Update Inventory stops the migration; nothing is changed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "InventoryLevel" GROUP BY "skuId" HAVING count(*) > 1 AND sum("quantity") > 99999) THEN
    RAISE EXCEPTION 'single_warehouse: a SKU would exceed 99999 units in one warehouse; lower its stock first';
  END IF;
END $$;

-- SKUs whose quantity in the kept warehouse changes: before (0 when they were not stored there) and the new total.
CREATE TABLE "_MergedStock" AS
SELECT l."skuId", s."shopId", k."id" AS "warehouseId",
       coalesce(sum(l."quantity") FILTER (WHERE l."warehouseId" = k."id"), 0)::int AS "before",
       sum(l."quantity")::int AS "after",
       bool_or(l."warehouseId" = k."id") AS "stored"
FROM "InventoryLevel" l
JOIN "Sku" s ON s."id" = l."skuId"
JOIN "_KeptWarehouse" k ON k."shopId" = s."shopId"
GROUP BY l."skuId", s."shopId", k."id";

INSERT INTO "InventoryChange" ("id", "shopId", "skuId", "warehouseId", "before", "after", "source", "noop", "note")
SELECT gen_random_uuid()::text, "shopId", "skuId", "warehouseId", "before", "after", 'ADMIN', false, 'single warehouse merge'
FROM "_MergedStock" WHERE "before" <> "after";

INSERT INTO "InventoryLevel" ("id", "skuId", "warehouseId", "quantity", "updatedAt")
SELECT gen_random_uuid()::text, "skuId", "warehouseId", "after", now()
FROM "_MergedStock" WHERE NOT "stored" OR "before" <> "after"
ON CONFLICT ("skuId", "warehouseId") DO UPDATE SET "quantity" = excluded."quantity", "updatedAt" = excluded."updatedAt";

UPDATE "Order" o SET "warehouseId" = k."id" FROM "_KeptWarehouse" k WHERE k."shopId" = o."shopId" AND o."warehouseId" <> k."id";

DELETE FROM "InventoryLevel" WHERE "warehouseId" NOT IN (SELECT "id" FROM "_KeptWarehouse");

DELETE FROM "Warehouse" WHERE "id" NOT IN (SELECT "id" FROM "_KeptWarehouse");

UPDATE "Warehouse" SET "isDefault" = true WHERE "isDefault" = false;

CREATE UNIQUE INDEX "Warehouse_shopId_key" ON "Warehouse"("shopId");

DROP TABLE "_MergedStock";

DROP TABLE "_KeptWarehouse";

COMMIT;
