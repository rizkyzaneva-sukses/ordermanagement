-- Migration: record the Shopee logistics channel per package
--
-- mass_ship_order (KB §4.2) only accepts a batch whose packages share one
-- logistics channel and warehouse. Without storing the channel the app can only
-- send a mixed batch and let Shopee reject part of it.

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "logisticsChannelId" INTEGER;

CREATE INDEX IF NOT EXISTS "orders_storeId_logisticsChannelId_idx"
  ON "orders" ("storeId", "logisticsChannelId");
