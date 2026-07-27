const express = require('express');
const router = express.Router();
const prisma = require('../prisma/client.js');
const { authenticate } = require('../middleware/auth.js');

router.use(authenticate);

/**
 * GET /status - Return last sync time per store
 */
router.get('/status', async (req, res) => {
  try {
    const user = req.user;

    const storeWhere = {};

    if (user.role === 'STAFF') {
      const access = await prisma.storeAccess.findMany({
        where: { userId: user.id },
        select: { storeId: true },
      });
      storeWhere.id = { in: access.map((a) => a.storeId) };
    }

    const stores = await prisma.store.findMany({
      where: storeWhere,
      select: {
        id: true,
        name: true,
        platform: true,
        updatedAt: true,
      },
    });

    return res.json({ success: true, data: stores });
  } catch (err) {
    console.error('GET /sync/status error:', err);
    return res.status(500).json({ success: false, error: 'Failed to get sync status' });
  }
});

module.exports = router;
