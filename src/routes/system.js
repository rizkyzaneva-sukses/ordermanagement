'use strict';

const express = require('express');
const router = express.Router();

const { authenticate } = require('../middleware/auth.js');
const { requireAdmin } = require('../middleware/role.js');
const systemChecks = require('../services/systemChecks.js');
const prisma = require('../prisma/client.js');
const { RETENTION_DAYS } = require('../services/activity.js');

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

/**
 * GET /activity - The activity log, newest first
 *
 * Query: page, limit, userId, q (label or email), from, to (YYYY-MM-DD, WIB
 * calendar days), failed=1 for failures only.
 */
router.get('/activity', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const where = {};
    if (req.query.userId) where.userId = String(req.query.userId);
    if (req.query.failed === '1') where.ok = false;
    if (req.query.q) {
      const q = String(req.query.q);
      where.OR = [
        { label: { contains: q, mode: 'insensitive' } },
        { userEmail: { contains: q, mode: 'insensitive' } },
        { targetId: { contains: q } },
      ];
    }
    // Days are the operator's days: WIB, UTC+7.
    const day = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? new Date(`${s}T00:00:00+07:00`) : null;
    const from = day(req.query.from);
    const to = day(req.query.to);
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lt = new Date(to.getTime() + 24 * 60 * 60 * 1000);
    }

    const [logs, total] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.activityLog.count({ where }),
    ]);

    return res.json({
      success: true,
      data: { logs, total, page, limit, totalPages: Math.ceil(total / limit), retentionDays: RETENTION_DAYS },
    });
  } catch (err) {
    console.error('GET /system/activity error:', err);
    return res.status(500).json({ success: false, error: 'Gagal memuat log aktivitas' });
  }
});

module.exports = router;
