-- Migration: record the outcome of each store sync
--
-- A sync failure previously left no trace outside the worker log: the API
-- answered "queued" and the UI showed an empty order list, which looks
-- identical to a shop that genuinely has no orders. These columns let the
-- interface tell the two apart, and flag the case where the merchant has to
-- re-authorize because the refresh token is dead.

ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "lastSyncStatus"    TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "lastSyncError"     TEXT;
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "lastSyncAttemptAt" TIMESTAMP(3);
ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "needsReconnect"    BOOLEAN NOT NULL DEFAULT false;
