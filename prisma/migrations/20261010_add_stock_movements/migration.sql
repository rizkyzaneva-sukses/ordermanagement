-- Migration: stok otomatis dari pesanan (PRD-stok-otomatis.md)
--
-- Adds the stock ledger, an app settings table, and three nullable columns on
-- orders. Only adds; nothing existing changes, and the feature stays off until
-- an admin switches it on.

CREATE TABLE IF NOT EXISTS "stock_movements" (
  "id"         TEXT NOT NULL,
  "productId"  TEXT NOT NULL,
  "kind"       TEXT NOT NULL,
  "delta"      INTEGER NOT NULL,
  "stockAfter" INTEGER NOT NULL,
  "storeId"    TEXT,
  "orderId"    TEXT,
  "itemId"     TEXT,
  "modelId"    TEXT,
  "userId"     TEXT,
  "note"       TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_movements_productId_fkey" FOREIGN KEY ("productId")
    REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "stock_movements_storeId_fkey" FOREIGN KEY ("storeId")
    REFERENCES "stores"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "stock_movements_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "stock_movements_storeId_orderId_itemId_modelId_kind_key"
  ON "stock_movements" ("storeId", "orderId", "itemId", "modelId", "kind");

CREATE INDEX IF NOT EXISTS "stock_movements_productId_createdAt_idx"
  ON "stock_movements" ("productId", "createdAt");

CREATE TABLE IF NOT EXISTS "app_settings" (
  "key"       TEXT NOT NULL,
  "value"     TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "stockCountedAt"  TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "stockShippedAt"  TIMESTAMP(3);
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "stockReleasedAt" TIMESTAMP(3);
