const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { initDB } = require('./db/database');
const { seed } = require('./db/seed');
const { getJwtSecret } = require('./routes/auth');

const authRoutes = require('./routes/auth').router;
const productsRoutes = require('./routes/products');
const ordersRoutes = require('./routes/orders');
const slidersRoutes = require('./routes/sliders');
const settingsRoutes = require('./routes/settings');
const analyticsRoutes = require('./routes/analytics');

const app = express();
const PORT = process.env.PORT || 4173;
const adminDirectory = path.join(__dirname, 'admin');

// Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  if (req.path === '/admin' || req.path.startsWith('/admin/')) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    );
    res.setHeader('Cache-Control', 'no-store');
  } else if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }

  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// Disable x-powered-by header
app.disable('x-powered-by');

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api', productsRoutes);
app.use('/api', ordersRoutes);
app.use('/api', slidersRoutes);
app.use('/api', settingsRoutes);
app.use('/api', analyticsRoutes);

// Serve only explicitly public files; never expose the database or server source.
app.use('/admin', express.static(adminDirectory, { dotfiles: 'deny', index: false }));
app.get('/admin', (req, res) => {
  res.sendFile(path.join(adminDirectory, 'index.html'));
});
app.get('/admin/{*path}', (req, res) => {
  res.sendFile(path.join(adminDirectory, 'index.html'));
});

app.use('/assets', express.static(path.join(__dirname, 'assets'), { dotfiles: 'deny' }));
app.use('/wp-content', express.static(path.join(__dirname, 'wp-content'), { dotfiles: 'deny' }));
app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/api/{*path}', (req, res) => {
  res.status(404).json({ error: 'API route not found' });
});

// Storefront fallback
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Error handling
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error('Unhandled Server Error:', err);
  const message = status === 413
    ? 'Uploaded file exceeds the allowed size'
    : status < 500 ? err.message : 'Internal Server Error';
  res.status(status).json({ error: message });
});

// Initialize DB and launch server
async function start() {
  try {
    getJwtSecret();
    await initDB();
    await seed();
    app.listen(PORT, () => {
      console.log(`====================================================`);
      console.log(` ResAir BD Web & Admin Server Running!`);
      console.log(` Storefront:  http://localhost:${PORT}`);
      console.log(` Admin Panel: http://localhost:${PORT}/admin`);
      console.log(`====================================================`);
    });
  } catch (err) {
    console.error('Failed to initialize server:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = app;
