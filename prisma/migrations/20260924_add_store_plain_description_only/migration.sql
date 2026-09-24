-- Migration: remember shops Shopee refuses extended (image) descriptions
--
-- Set by Publish when add_item answers "not in the whitelist to add images in
-- description". Only adds a column; nothing existing changes.

ALTER TABLE "stores" ADD COLUMN IF NOT EXISTS "plainDescriptionOnly" BOOLEAN NOT NULL DEFAULT false;
