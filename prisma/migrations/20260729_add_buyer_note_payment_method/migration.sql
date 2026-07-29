-- Migration: add buyerNote and paymentMethod to orders table
-- Based on Shopee KB: note = buyer instructions to seller, payment_method = COD detection

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "buyerNote" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT;
