-- Migration: record how the last sync's own numbers compared with Shopee's
--
-- The sync already asks Shopee how many orders sit in each status, uses the
-- answer to fetch them, and throws it away. Keeping it lets the app say whether
-- its data agrees with the marketplace, instead of only whether the request
-- succeeded. Those are different questions, and the second one is the one an
-- operator actually needs answered before trusting the list.

ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "lastSyncCounts" TEXT;
