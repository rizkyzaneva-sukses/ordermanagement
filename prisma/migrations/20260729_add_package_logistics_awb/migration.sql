-- Migration: package-level identity, fulfillment status, and Shopee AWB storage
--
-- Background (shopee-order-management-kb.md):
--   §1    a Shopee order can hold 1..N packages, and each package ships,
--         tracks and prints independently — so an `orders` row is a package.
--   §3.2  fulfillment/logistics status is separate from order status.
--   §7.3  an AWB may only be printed before LOGISTICS_PICKUP_DONE; without
--         storing the fulfillment status that rule cannot be enforced.
--   §7.1/§7.2 the downloaded AWB is not always a PDF (HTML in TW, ZIP for
--         thermal printing), so the format has to be recorded alongside it.

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "packageNumber"   TEXT NOT NULL DEFAULT '';
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "logisticsStatus" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelReason"    TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "awbPath"         TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "awbFormat"       TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "awbDocumentType" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "awbFetchedAt"    TIMESTAMP(3);

-- Existing rows predate package awareness: they represent whichever package
-- Shopee reported first, which is the order's default package.
UPDATE "orders" SET "packageNumber" = '' WHERE "packageNumber" IS NULL;

-- One row per (store, order, package).
--
-- This index is intentionally created without de-duplicating first. If it
-- fails, the database already holds two rows for the same package — that is a
-- pre-existing data bug and deleting one automatically could discard print
-- history. Inspect them by hand with:
--
--   SELECT "storeId", "orderId", "packageNumber", COUNT(*), array_agg("id")
--   FROM "orders"
--   GROUP BY "storeId", "orderId", "packageNumber"
--   HAVING COUNT(*) > 1;
--
-- Keep the row whose "printedAt" is set (or the newest if none were printed),
-- delete the rest, then re-run this migration.
CREATE UNIQUE INDEX IF NOT EXISTS "orders_storeId_orderId_packageNumber_key"
  ON "orders" ("storeId", "orderId", "packageNumber");

CREATE INDEX IF NOT EXISTS "orders_storeId_logisticsStatus_idx"
  ON "orders" ("storeId", "logisticsStatus");
