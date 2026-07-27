'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const prisma = require('../prisma/client');
const { authenticate } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/role');

const router = express.Router();

// All user management routes require ADMIN
router.use(authenticate, requireAdmin());

const SALT_ROUNDS = 12;

/**
 * GET /
 * List all users with their store access
 */
router.get('/', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { isActive: true },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        storeAccess: {
          select: {
            store: {
              select: { id: true, name: true, platform: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const data = users.map((user) => ({
      ...user,
      storeAccess: user.storeAccess.map((sa) => sa.store),
    }));

    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to list users' });
  }
});

/**
 * POST /
 * Create a new user
 * Body: { email, password, name, role, storeIds[] }
 */
router.post('/', async (req, res) => {
  try {
    const { email, password, name, role, storeIds } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ success: false, error: 'Email already in use' });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          password: hashedPassword,
          name: name || null,
          role: role || 'STAFF',
        },
      });

      if (storeIds && Array.isArray(storeIds) && storeIds.length > 0) {
        await tx.storeAccess.createMany({
          data: storeIds.map((storeId) => ({
            userId: created.id,
            storeId,
          })),
        });
      }

      return created;
    });

    // Fetch with storeAccess
    const result = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        createdAt: true,
        storeAccess: {
          select: {
            store: { select: { id: true, name: true, platform: true } },
          },
        },
      },
    });

    return res.status(201).json({
      success: true,
      data: { ...result, storeAccess: result.storeAccess.map((sa) => sa.store) },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to create user' });
  }
});

/**
 * PATCH /:id
 * Update user fields (email, name, role, password, isActive)
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { email, name, role, password, isActive } = req.body;

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const data = {};
    if (email !== undefined) data.email = email;
    if (name !== undefined) data.name = name;
    if (role !== undefined) data.role = role;
    if (isActive !== undefined) data.isActive = isActive;
    if (password) data.password = await bcrypt.hash(password, SALT_ROUNDS);

    const user = await prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.json({ success: true, data: user });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'Email already in use' });
    }
    return res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

/**
 * DELETE /:id
 * Soft delete: set isActive = false
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    await prisma.user.update({
      where: { id },
      data: { isActive: false },
    });

    return res.json({ success: true, data: { message: 'User deactivated' } });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to delete user' });
  }
});

/**
 * PATCH /:id/stores
 * Set store access for a user
 * Body: { storeIds: [...] }
 * Deletes old access records and creates new ones atomically
 */
router.patch('/:id/stores', async (req, res) => {
  try {
    const { id } = req.params;
    const { storeIds } = req.body;

    if (!Array.isArray(storeIds)) {
      return res.status(400).json({ success: false, error: 'storeIds must be an array' });
    }

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.storeAccess.deleteMany({ where: { userId: id } });

      if (storeIds.length > 0) {
        await tx.storeAccess.createMany({
          data: storeIds.map((storeId) => ({ userId: id, storeId })),
        });
      }
    });

    // Return updated user with storeAccess
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        storeAccess: {
          select: {
            store: { select: { id: true, name: true, platform: true } },
          },
        },
      },
    });

    return res.json({
      success: true,
      data: { ...user, storeAccess: user.storeAccess.map((sa) => sa.store) },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to update store access' });
  }
});

module.exports = router;
