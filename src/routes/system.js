'use strict';

const express = require('express');
const router = express.Router();

const { authenticate } = require('../middleware/auth.js');
const { requireAdmin } = require('../middleware/role.js');
const systemChecks = require('../services/systemChecks.js');

// Admin only, and for a reason beyond tidiness: the results name environment
// variables, storage paths and shop names. That is a map of the deployment, and
// it does not belong in front of every operator.
router.use(authenticate);
router.use(requireAdmin());

/**
 * GET /checks - Run the deployment diagnostics
 *
 * Query: ?only=<check id> to re-run a single row.
 */
router.get('/checks', async (req, res) => {
  try {
    const data = await systemChecks.runAll({ only: req.query.only });
    return res.json({ success: true, data });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error('GET /system/checks error:', err);
    return res.status(status).json({ success: false, error: err.message });
  }
});

module.exports = router;
