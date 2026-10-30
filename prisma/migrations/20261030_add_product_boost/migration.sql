-- Migration: Naikkan Produk otomatis
--
-- Adds three columns on stores and the boost history table. Only adds; every
-- shop starts with auto-boost off until someone switches it on.

ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "autoBoost" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "boostLastRunAt" TIMESTAMP(3);
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "boostLastError" TEXT;

CREATE TABLE IF NOT EXISTS "product_boosts" (
  "id"        TEXT NOT NULL,
  "storeId"   TEXT NOT NULL,
  "itemId"    TEXT NOT NULL,
  "itemName"  TEXT,
  "ok"        BOOLEAN NOT NULL,
  "reason"    TEXT,
  "auto"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_boosts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "product_boosts_storeId_fkey" FOREIGN KEY ("storeId")
    REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "product_boosts_storeId_createdAt_idx" ON "product_boosts" ("storeId", "createdAt");
CREATE INDEX IF NOT EXISTS "product_boosts_storeId_itemId_idx" ON "product_boosts" ("storeId", "itemId");
