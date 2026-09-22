-- Migration: Shopee chat inbox
--
-- `buyerUserId` links a chat conversation to the buyer's orders. The name on
-- the order is the recipient on the label (masked), not the chat user, so it
-- cannot do that job. Nullable: rows synced before this carry no id until the
-- next detail refresh fills it in.
--
-- `chat_replies` records who sent each reply from OrderPro. The conversations
-- stay on Shopee; only the authorship Shopee does not know about is kept here.

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "buyerUserId" TEXT;

CREATE INDEX IF NOT EXISTS "orders_storeId_buyerUserId_idx"
  ON "orders" ("storeId", "buyerUserId");

CREATE TABLE IF NOT EXISTS "chat_replies" (
  "id"             TEXT NOT NULL,
  "storeId"        TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "messageId"      TEXT,
  "toId"           TEXT NOT NULL,
  "messageType"    TEXT NOT NULL,
  "text"           TEXT,
  "imageUrl"       TEXT,
  "sentById"       TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_replies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chat_replies_storeId_fkey" FOREIGN KEY ("storeId")
    REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "chat_replies_sentById_fkey" FOREIGN KEY ("sentById")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "chat_replies_storeId_conversationId_idx"
  ON "chat_replies" ("storeId", "conversationId");
