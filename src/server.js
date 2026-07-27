const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3001',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Serve generated PDFs
app.use('/storage', express.static(path.join(__dirname, '../storage')));

// Root - app info
app.get('/', (req, res) => {
  res.json({
    name: 'OrderPro API',
    version: '1.0.0',
    description: 'Order management for Shopee & TikTok Shop',
    health: '/api/health',
    docs: {
      auth: '/api/auth',
      stores: '/api/stores',
      orders: '/api/orders',
      sync: '/api/sync',
      dashboard: '/api/dashboard',
      print: '/api/print'
    }
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/stores', require('./routes/stores'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/print', require('./routes/print'));
app.use('/api/sync', require('./routes/sync'));
app.use('/api/dashboard', require('./routes/dashboard'));

// Global error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message, err.stack);
  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`OrderPro API running on port ${PORT}`);
});
