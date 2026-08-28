-- Migration: record Shopee's shipping deadline per package
--
-- `ship_by_date` is the deadline the marketplace holds the seller to, and it is
-- what decides the order of work: an order due today outranks one that arrived
-- earlier but is due in three days. Komplace shows it. Nothing here could.
--
-- Nullable by necessity — Shopee only reports it while an order is awaiting
-- shipment, and every row that already exists predates the column.

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "shipByDate" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "orders_storeId_shipByDate_idx"
  ON "orders" ("storeId", "shipByDate");
