#!/bin/bash
set -e

echo "========================================="
echo "  OrderPro - Setup Script"
echo "========================================="

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "Error: Node.js is required but not installed."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "Error: npm is required but not installed."; exit 1; }

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "Error: Node.js 18+ is required. Current version: $(node -v)"
  exit 1
fi

echo ""
echo "[1/4] Installing dependencies..."
npm install

echo ""
echo "[2/4] Generating Prisma client..."
npx prisma generate

echo ""
echo "[3/4] Running database migrations..."
npx prisma migrate dev --name init

echo ""
echo "[4/4] Seeding database..."
node scripts/seed.js

echo ""
echo "========================================="
echo "  Setup complete!"
echo "========================================="
echo ""
echo "  Development:  npm run dev"
echo "  Production:   npm start"
echo ""
