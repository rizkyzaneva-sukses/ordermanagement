const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  const adminPasswordHash = await bcrypt.hash('admin123', 10);
  const staffPasswordHash = await bcrypt.hash('staff123', 10);

  // Create admin user
  const admin = await prisma.user.upsert({
    where: { email: 'admin@orderpro.id' },
    update: {},
    create: {
      email: 'admin@orderpro.id',
      password: adminPasswordHash,
      name: 'Admin OrderPro',
      role: 'ADMIN',
    },
  });
  console.log('  ✓ Admin user: admin@orderpro.id / admin123');

  // Create sample stores
  const storeShopee = await prisma.store.upsert({
    where: { shopId: 'SHOP123456' },
    update: {},
    create: {
      name: 'Toko Contoh Shopee',
      platform: 'SHOPEE',
      shopId: 'SHOP123456',
      accessToken: 'shopee_dummy_access_token_12345',
      refreshToken: 'shopee_dummy_refresh_token_12345',
      tokenExpiry: new Date(Date.now() + 4 * 60 * 60 * 1000), // 4 hours from now
    },
  });
  console.log('  ✓ Store: Toko Contoh Shopee');

  const storeTiktok = await prisma.store.upsert({
    where: { shopId: 'TIKTOK_SHOP_789' },
    update: {},
    create: {
      name: 'Toko Contoh TikTok',
      platform: 'TIKTOK',
      shopId: 'TIKTOK_SHOP_789',
      accessToken: 'tiktok_dummy_access_token_67890',
      refreshToken: 'tiktok_dummy_refresh_token_67890',
      tokenExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
    },
  });
  console.log('  ✓ Store: Toko Contoh TikTok');

  // Create staff user
  const staff = await prisma.user.upsert({
    where: { email: 'staff@orderpro.id' },
    update: {},
    create: {
      email: 'staff@orderpro.id',
      password: staffPasswordHash,
      name: 'Staff Toko',
      role: 'STAFF',
    },
  });
  console.log('  ✓ Staff user: staff@orderpro.id / staff123');

  // Assign staff to Shopee store
  await prisma.storeAccess.upsert({
    where: { userId_storeId: { userId: staff.id, storeId: storeShopee.id } },
    update: {},
    create: {
      userId: staff.id,
      storeId: storeShopee.id,
    },
  });
  console.log('  ✓ Staff → Toko Contoh Shopee access granted');

  console.log('\nSeeding completed!');
}

main()
  .catch((e) => {
    console.error('Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
