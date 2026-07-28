#!/bin/bash
# Run this on the production server to apply schema changes
# Usage: bash scripts/apply-migration.sh

echo "=== Applying migration: fix shopId unique + add lastSyncAt ==="

# Apply migration via prisma migrate deploy
npx prisma migrate deploy

echo ""
echo "=== Migration complete. Please restart the app ==="
echo "  pm2 restart all"
echo "  # or: docker-compose restart app worker"
