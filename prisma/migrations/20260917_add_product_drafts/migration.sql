-- Migration: drafts for "Salin Produk" (copy a Shopee item to another shop)
--
-- One row per item per destination shop, from the moment it is copied until it
-- is published there. Mirrors Komplace's Draf tab (operator doc, 17 Sep 2026).
--
-- Additive only: a new table, nothing existing changes.

CREATE TABLE IF NOT EXISTS "product_drafts" (
    "id"               TEXT NOT NULL,
    "sourceStoreId"    TEXT NOT NULL,
    "sourceItemId"     TEXT NOT NULL,
    "targetStoreId"    TEXT NOT NULL,
    "status"           TEXT NOT NULL DEFAULT 'DRAFT',
    "payload"          JSONB NOT NULL,
    "sourceSnapshot"   JSONB NOT NULL,
    "uploadedImages"   JSONB NOT NULL DEFAULT '{}',
    "publishedItemId"  TEXT,
    "publishSteps"     JSONB NOT NULL DEFAULT '{}',
    "lastError"        TEXT,
    "lastErrorRaw"     JSONB,
    "publishStartedAt" TIMESTAMP(3),
    "publishedAt"      TIMESTAMP(3),
    "createdById"      TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_drafts_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "product_drafts"
    ADD CONSTRAINT "product_drafts_sourceStoreId_fkey"
    FOREIGN KEY ("sourceStoreId") REFERENCES "stores" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "product_drafts"
    ADD CONSTRAINT "product_drafts_targetStoreId_fkey"
    FOREIGN KEY ("targetStoreId") REFERENCES "stores" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A draft outlives the account that made it
DO $$ BEGIN
  ALTER TABLE "product_drafts"
    ADD CONSTRAINT "product_drafts_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "product_drafts_targetStoreId_status_idx"
  ON "product_drafts" ("targetStoreId", "status");

CREATE INDEX IF NOT EXISTS "product_drafts_sourceStoreId_sourceItemId_idx"
  ON "product_drafts" ("sourceStoreId", "sourceItemId");
