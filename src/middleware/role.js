'use strict';

/**
 * Role-based access control middleware factory.
 * Must be used after authenticate middleware (requires req.user).
 *
 * @param  {...string} roles - Allowed roles
 * @returns {Function} Express middleware
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions' });
    }

    next();
  };
}

/**
 * Convenience: require ADMIN role
 */
function requireAdmin() {
  return requireRole('ADMIN');
}

module.exports = { requireRole, requireAdmin };
