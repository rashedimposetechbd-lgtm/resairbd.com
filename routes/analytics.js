const express = require('express');
const router = express.Router();
const { get, run, all } = require('../db/database');
const { requireAuth, requireRole } = require('./auth');

const eventWindowMs = 15 * 60 * 1000;
const eventLimit = 120;
const eventAttempts = new Map();
const allowedEventTypes = new Set([
  'pageview',
  'product_view',
  'category_view',
  'search',
  'add_to_cart',
  'checkout_start',
  'order_submit',
  'rental_booking'
]);

function limitAnalyticsEvents(req, res, next) {
  const now = Date.now();
  if (eventAttempts.size > 10000) {
    for (const [key, state] of eventAttempts) {
      if (now - state.startedAt >= eventWindowMs) eventAttempts.delete(key);
    }
  }
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  let state = eventAttempts.get(key);
  if (!state || now - state.startedAt >= eventWindowMs) {
    state = { startedAt: now, count: 0 };
    eventAttempts.set(key, state);
  }
  if (state.count >= eventLimit) {
    const retryAfter = Math.ceil((eventWindowMs - (now - state.startedAt)) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many analytics events. Please try again later.' });
  }
  state.count += 1;
  next();
}

// POST /api/analytics/event - Public privacy-friendly tracking
router.post('/analytics/event', limitAnalyticsEvents, async (req, res) => {
  try {
    // Respect Do Not Track
    if (req.headers['dnt'] === '1') {
      return res.json({ success: true, tracked: false });
    }

    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Event data must be an object' });
    }
    const { eventType, targetId = '', path: pagePath = '', referrer = '' } = body;
    if (typeof eventType !== 'string' || !allowedEventTypes.has(eventType)) {
      return res.status(400).json({ error: 'Unsupported analytics event type' });
    }
    if (typeof targetId !== 'string' || targetId.length > 120 ||
        typeof pagePath !== 'string' || pagePath.length > 200 ||
        (pagePath && (!pagePath.startsWith('/') || pagePath.startsWith('//'))) ||
        typeof referrer !== 'string' || referrer.length > 300) {
      return res.status(400).json({ error: 'Analytics event fields are invalid' });
    }
    if (referrer) {
      try {
        const parsedReferrer = new URL(referrer);
        if (!['http:', 'https:'].includes(parsedReferrer.protocol)) {
          return res.status(400).json({ error: 'Referrer must use HTTP or HTTPS' });
        }
      } catch {
        return res.status(400).json({ error: 'Referrer must be a valid URL' });
      }
    }

    const now = new Date().toISOString();
    await run(`
      INSERT INTO analytics_events (event_type, target_id, path, referrer, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, [
      eventType,
      targetId,
      pagePath,
      referrer,
      now
    ]);

    res.json({ success: true, tracked: true });
  } catch (err) {
    console.error('Record analytics event error:', err);
    res.status(500).json({ error: 'Failed to record event' });
  }
});

// GET /api/analytics/overview - Auth required
router.get('/analytics/overview', requireAuth, requireRole('owner', 'staff'), async (req, res) => {
  try {
    // Product metrics
    const prodCounts = await get(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN in_stock = 1 THEN 1 ELSE 0 END) as inStock,
        SUM(CASE WHEN in_stock = 0 THEN 1 ELSE 0 END) as outOfStock
      FROM products
    `);

    // Order metrics
    const orderMetrics = await get(`
      SELECT
        COUNT(*) as totalOrders,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pendingOrders,
        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as deliveredOrders,
        COALESCE(SUM(grand_total), 0) as totalRevenue
      FROM orders
    `);

    // Rental booking metrics
    const bookingMetrics = await get(`
      SELECT
        COUNT(*) as totalBookings,
        SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as newBookings
      FROM service_bookings
    `);

    // Traffic metrics
    const today = new Date().toISOString().split('T')[0];
    const trafficToday = await get(`
      SELECT COUNT(*) as count FROM analytics_events
      WHERE event_type = 'pageview' AND created_at LIKE ?
    `, [`${today}%`]);

    const trafficWeek = await get(`
      SELECT COUNT(*) as count FROM analytics_events
      WHERE event_type = 'pageview' AND datetime(created_at) >= datetime('now', '-7 days')
    `);

    // Top viewed products
    const topProducts = await all(`
      SELECT target_id, COUNT(*) as views
      FROM analytics_events
      WHERE event_type = 'product_view' AND target_id != ''
      GROUP BY target_id
      ORDER BY views DESC
      LIMIT 5
    `);

    // Recent orders
    const recentOrders = await all('SELECT * FROM orders ORDER BY id DESC LIMIT 5');

    // Recent bookings
    const recentBookings = await all('SELECT * FROM service_bookings ORDER BY id DESC LIMIT 5');

    res.json({
      products: {
        total: prodCounts ? prodCounts.total : 0,
        inStock: prodCounts ? prodCounts.inStock : 0,
        outOfStock: prodCounts ? prodCounts.outOfStock : 0
      },
      orders: {
        total: orderMetrics ? orderMetrics.totalOrders : 0,
        pending: orderMetrics ? orderMetrics.pendingOrders : 0,
        delivered: orderMetrics ? orderMetrics.deliveredOrders : 0,
        revenue: orderMetrics ? orderMetrics.totalRevenue : 0
      },
      bookings: {
        total: bookingMetrics ? bookingMetrics.totalBookings : 0,
        new: bookingMetrics ? bookingMetrics.newBookings : 0
      },
      traffic: {
        today: trafficToday ? trafficToday.count : 0,
        week: trafficWeek ? trafficWeek.count : 0
      },
      topProducts,
      recentOrders: recentOrders.map(r => ({
        ...r,
        items: r.items_json ? JSON.parse(r.items_json) : []
      })),
      recentBookings
    });
  } catch (err) {
    console.error('Analytics overview error:', err);
    res.status(500).json({ error: 'Failed to load analytics overview' });
  }
});

// GET /api/audit-logs - Auth required
router.get('/audit-logs', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const logs = await all('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50');
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

module.exports = router;
