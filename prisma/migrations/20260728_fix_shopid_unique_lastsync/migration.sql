-- Migration: Fix shopId unique constraint + add lastSyncAt column
-- Replaces: stores_shopId_key (per-column unique) 
-- With: stores_platform_shopId_key (composite unique per platform)
-- Also: adds lastSyncAt column for accurate sync tracking

-- Step 1: Drop old unique constraint on shopId only
DROP INDEX IF EXISTS "stores_shopId_key";

-- Step 2: Add lastSyncAt column (nullable)
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "lastSyncAt" TIMESTAMP(3);

-- Step 3: Create new composite unique index (platform + shopId)
CREATE UNIQUE INDEX IF NOT EXISTS "stores_platform_shopId_key" ON "stores"("platform", "shopId");
