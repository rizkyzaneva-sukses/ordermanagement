const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Serve generated PDFs
app.use('/storage', express.static(path.join(__dirname, '../storage')));

// ── API Routes ────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/oauth', require('./routes/oauth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/stores', require('./routes/stores'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/print', require('./routes/print'));
app.use('/api/sync', require('./routes/sync'));
app.use('/api/dashboard', require('./routes/dashboard'));

// ── Frontend (Next.js static export) ──────────────────
const frontendPath = path.join(__dirname, '../frontend/out');

if (fs.existsSync(frontendPath)) {
  // Serve static assets (JS, CSS, images, etc.)
  app.use(express.static(frontendPath, {
    index: false,
    maxAge: '1y',
    etag: true,
  }));

  // Server-side redirect: / → /login/
  app.get('/', (req, res) => {
    res.redirect(302, '/login/');
  });

  // Client-side routing: serve correct index.html for each route
  app.get('*', (req, res) => {
    const cleanPath = req.path.replace(/\/+$/, '') || '';
    // Try /login/index.html, /dashboard/index.html, etc.
    const dirIndex = path.join(frontendPath, cleanPath, 'index.html');
    if (fs.existsSync(dirIndex)) {
      return res.sendFile(dirIndex);
    }
    // Try exact file match
    const filePath = path.join(frontendPath, req.path);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return res.sendFile(filePath);
    }
    // Fallback to root index.html
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
} else {
  // No frontend built yet — API-only mode
  app.get('/', (req, res) => {
    res.json({
      name: 'OrderPro API',
      version: '1.0.0',
      description: 'Order management for Shopee & TikTok Shop',
      note: 'Frontend not built. Run: cd frontend && npm run build',
    });
  });
}

// Global error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message, err.stack);
  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

const PORT = process.env.PORT || 80;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`OrderPro running on port ${PORT}`);

  // ── Auto-sync scheduler ────────────────────────────
  // Register repeatable BullMQ jobs for all active stores.
  // Each store gets synced every SYNC_INTERVAL_MS (default 15 min).
  const scheduler = require('./services/scheduler');
  scheduler.start().catch((err) => {
    console.error('[scheduler] Failed to start:', err.message);
  });
});

