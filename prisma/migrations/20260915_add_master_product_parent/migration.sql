-- Migration: a parent level above master SKUs, matching Komplace
--
-- A screen recording of Komplace (14 Sep 2026) showed "Jadikan Master" working
-- per item: one Master Produk ("Belva Vest") holding one Master SKU per
-- variation, each starting from the stock the listing already had. The flat
-- products table could only express the second half, so selecting five
-- variations collapsed them into a single SKU.
--
-- Additive only. Existing masters keep masterProductId NULL and go on working
-- as flat SKUs; nothing is backfilled, because which of them belong together is
-- an operator's call rather than something a migration can infer.

CREATE TABLE IF NOT EXISTS "master_products" (
    "id"        TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "master_products_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "masterProductId" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "variantName" TEXT;

-- Deleting a parent orphans its SKUs rather than deleting them: the SKUs are
-- what listings are bound to and what stock is typed against.
DO $$ BEGIN
  ALTER TABLE "products"
    ADD CONSTRAINT "products_masterProductId_fkey"
    FOREIGN KEY ("masterProductId") REFERENCES "master_products" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "products_masterProductId_idx"
  ON "products" ("masterProductId");

-- Filled by the next catalogue pull. Until then the app derives the item name
-- from sibling listings, so these being NULL is not an error.
ALTER TABLE "product_listings" ADD COLUMN IF NOT EXISTS "itemName" TEXT;
ALTER TABLE "product_listings" ADD COLUMN IF NOT EXISTS "modelName" TEXT;
