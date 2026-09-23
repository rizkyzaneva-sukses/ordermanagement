-- Migration: admin activity log
--
-- One row per recorded action (see src/services/activity.js). Only adds a
-- table; nothing existing changes.

CREATE TABLE IF NOT EXISTS "activity_logs" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT,
  "userEmail"  TEXT,
  "action"     TEXT NOT NULL,
  "label"      TEXT NOT NULL,
  "targetId"   TEXT,
  "ok"         BOOLEAN NOT NULL,
  "statusCode" INTEGER NOT NULL,
  "detail"     JSONB,
  "ip"         TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "activity_logs_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "activity_logs_createdAt_idx"
  ON "activity_logs" ("createdAt");

CREATE INDEX IF NOT EXISTS "activity_logs_userId_createdAt_idx"
  ON "activity_logs" ("userId", "createdAt");
