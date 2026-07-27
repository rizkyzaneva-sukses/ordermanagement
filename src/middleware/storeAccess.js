'use strict';

const prisma = require('../prisma/client');

/**
 * Store access middleware.
 * - ADMIN: always passes
 * - STAFF: checks StoreAccess table for the given storeId (from req.params.id)
 *   Returns 403 if no access record exists.
 *
 * Must be used after authenticate middleware.
 */
async function checkStoreAccess(req, res, next) {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    // ADMINs have unrestricted access
    if (user.role === 'ADMIN') {
      return next();
    }

    const storeId = req.params.id || req.params.storeId;

    if (!storeId) {
      return res.status(400).json({ success: false, error: 'Store ID is required' });
    }

    const access = await prisma.storeAccess.findFirst({
      where: {
        userId: user.id,
        storeId: storeId,
      },
    });

    if (!access) {
      return res.status(403).json({ success: false, error: 'No access to this store' });
    }

    next();
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to verify store access' });
  }
}

module.exports = { checkStoreAccess };
