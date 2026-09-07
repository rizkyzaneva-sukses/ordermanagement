-- Migration: master products and the marketplace listings they tie together
--
-- The first step of the product feature, and deliberately the read-only one: it
-- gives the catalogue somewhere to live so a shop's ~1300 listings can be pulled
-- in and looked at before anything writes back to Shopee. Nothing here needs a
-- product write permission.
--
-- Two shapes worth explaining, because both were choices rather than defaults:
--
--   products      is flat — one master, one SKU, one stock number typed by an
--                 operator. It matches Komplace, which means a bundle cannot be
--                 a master, and selling a component on its own will not move a
--                 bundle's stock. Known and accepted, not an oversight.
--
--   product_listings.modelId is an empty string rather than NULL for a listing
--                 with no variations. Postgres treats NULLs as distinct, so a
--                 nullable column here would let the same item be inserted
--                 twice past the unique constraint — the same trap already
--                 handled on orders.packageNumber.

CREATE TABLE IF NOT EXISTS "products" (
    "id"        TEXT NOT NULL,
    "masterSku" TEXT NOT NULL,
    "name"      TEXT NOT NULL,
    "stock"     INTEGER NOT NULL DEFAULT 0,
    "isActive"  BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "products_masterSku_key"
  ON "products" ("masterSku");

CREATE TABLE IF NOT EXISTS "product_listings" (
    "id"           TEXT NOT NULL,
    "storeId"      TEXT NOT NULL,
    "productId"    TEXT,
    "platform"     TEXT NOT NULL,
    "itemId"       TEXT NOT NULL,
    "modelId"      TEXT NOT NULL DEFAULT '',
    "sku"          TEXT,
    "name"         TEXT NOT NULL,
    "status"       TEXT NOT NULL,
    "price"        DOUBLE PRECISION,
    "stock"        INTEGER,
    "imageUrl"     TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_listings_pkey" PRIMARY KEY ("id"),

    -- Losing the shop should take its listings with it; losing a master should
    -- only orphan the mapping, because the listing still exists on Shopee.
    CONSTRAINT "product_listings_storeId_fkey"
      FOREIGN KEY ("storeId") REFERENCES "stores" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "product_listings_productId_fkey"
      FOREIGN KEY ("productId") REFERENCES "products" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_listings_storeId_itemId_modelId_key"
  ON "product_listings" ("storeId", "itemId", "modelId");

CREATE INDEX IF NOT EXISTS "product_listings_productId_idx"
  ON "product_listings" ("productId");

CREATE INDEX IF NOT EXISTS "product_listings_storeId_status_idx"
  ON "product_listings" ("storeId", "status");

-- Matching a listing to a master is a SKU lookup across every shop, so the
-- index is on sku alone rather than scoped to a store.
CREATE INDEX IF NOT EXISTS "product_listings_sku_idx"
  ON "product_listings" ("sku");
