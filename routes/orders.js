const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { get, run, all } = require('../db/database');
const { requireAuth, requireRole, logAudit } = require('./auth');

const SUBMISSION_WINDOW_MS = 15 * 60 * 1000;
const SUBMISSION_LIMIT = 10;
const publicSubmissions = new Map();
const orderStatuses = ['pending', 'confirmed', 'processing', 'delivered', 'cancelled'];
const bookingStatuses = ['new', 'contacted', 'in_service', 'completed', 'cancelled'];

function limitPublicSubmissions(req, res, next) {
  const now = Date.now();
  if (publicSubmissions.size > 10000) {
    for (const [key, state] of publicSubmissions) {
      if (now - state.startedAt >= SUBMISSION_WINDOW_MS) publicSubmissions.delete(key);
    }
  }

  const key = `${req.path}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
  let state = publicSubmissions.get(key);
  if (!state || now - state.startedAt >= SUBMISSION_WINDOW_MS) {
    state = { startedAt: now, count: 0 };
    publicSubmissions.set(key, state);
  }
  if (state.count >= SUBMISSION_LIMIT) {
    const retryAfter = Math.ceil((SUBMISSION_WINDOW_MS - (now - state.startedAt)) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many submissions. Please try again later.' });
  }

  state.count += 1;
  next();
}

function text(value, maxLength, { required = false } = {}) {
  return typeof value === 'string' && value.trim().length <= maxLength &&
    (!required || value.trim().length > 0);
}

function isPhoneNumber(value) {
  return typeof value === 'string' && /^01[3-9]\d{8}$/.test(value.trim());
}

function getOrder(r) {
  return {
    id: r.id,
    orderId: r.order_id,
    date: r.date,
    customer: {
      name: r.customer_name,
      phone: r.customer_phone,
      altPhone: r.customer_alt_phone,
      area: r.customer_area,
      address: r.customer_address,
      notes: r.customer_notes
    },
    paymentMethod: r.payment_method,
    items: r.items_json ? JSON.parse(r.items_json) : [],
    subtotal: Number(r.subtotal),
    deliveryFee: Number(r.delivery_fee),
    grandTotal: Number(r.grand_total),
    status: r.status,
    createdAt: r.created_at
  };
}

function getBooking(r) {
  return {
    id: r.id,
    bookingId: r.booking_id,
    type: r.type,
    customer: {
      name: r.customer_name,
      phone: r.customer_phone,
      address: r.customer_address
    },
    details: r.details || '',
    status: r.status,
    createdAt: r.created_at
  };
}

function parseListQuery(query, allowedStatuses) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  const status = typeof query.status === 'string' ? query.status : 'all';
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 120) : '';

  if (!Number.isSafeInteger(page) || page < 1 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return { error: 'Page and limit must be positive integers; limit cannot exceed 100' };
  }
  if (status !== 'all' && !allowedStatuses.includes(status)) {
    return { error: 'Invalid status filter' };
  }
  return { page, limit, status, q };
}

function applySearch(where, params, query, fields) {
  if (!query) return;
  const term = `%${query}%`;
  where.push(`(${fields.map(field => `${field} LIKE ?`).join(' OR ')})`);
  params.push(...fields.map(() => term));
}

function makeReference(prefix, bytes = 6) {
  return `${prefix}-${crypto.randomBytes(bytes).toString('hex').toUpperCase()}`;
}

async function inTransaction(action) {
  await run('BEGIN IMMEDIATE');
  try {
    const result = await action();
    await run('COMMIT');
    return result;
  } catch (err) {
    await run('ROLLBACK');
    throw err;
  }
}

// Public checkout: prices and totals are always derived from the active catalog.
router.post('/orders', limitPublicSubmissions, async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Order data must be an object' });
    }
    const { customer, paymentMethod, items } = body;
    if (!customer || typeof customer !== 'object' || Array.isArray(customer)) {
      return res.status(400).json({ error: 'Customer details are required' });
    }
    if (!text(customer.name, 120, { required: true }) ||
        !isPhoneNumber(customer.phone) ||
        (customer.altPhone && !isPhoneNumber(customer.altPhone)) ||
        !text(customer.address, 1000, { required: true }) ||
        (customer.notes !== undefined && !text(customer.notes, 2000)) ||
        !['dhaka', 'outside'].includes(customer.area)) {
      return res.status(400).json({ error: 'Customer details are invalid' });
    }
    if (!['COD', 'BKASH'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Choose a supported payment method' });
    }
    if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
      return res.status(400).json({ error: 'An order must contain between 1 and 50 products' });
    }

    const normalizedItems = [];
    const seenProducts = new Set();
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
          !Number.isSafeInteger(item.qty) || item.qty < 1 || item.qty > 99 ||
          (typeof item.uid !== 'string' && typeof item.id !== 'string')) {
        return res.status(400).json({ error: 'Order items must include a valid product and quantity' });
      }

      const lookup = typeof item.uid === 'string' ? item.uid : item.id;
      const product = await get(
        'SELECT id, uid, name, price, image, in_stock FROM products WHERE (uid = ? OR id = ?) AND is_active = 1',
        [lookup, lookup]
      );
      if (!product) {
        return res.status(400).json({ error: 'One or more products are no longer available' });
      }
      if (!product.in_stock) {
        return res.status(409).json({ error: `${product.name} is currently out of stock` });
      }
      if (seenProducts.has(product.uid)) {
        return res.status(400).json({ error: 'An order cannot contain the same product more than once' });
      }
      seenProducts.add(product.uid);
      normalizedItems.push({
        id: product.id,
        uid: product.uid,
        name: product.name,
        price: Number(product.price),
        image: product.image,
        qty: item.qty
      });
    }

    const subtotal = Math.round(normalizedItems.reduce(
      (sum, item) => sum + item.price * item.qty,
      0
    ) * 100) / 100;
    const deliverySettings = await all(
      'SELECT key, value FROM site_settings WHERE key IN (?, ?, ?)',
      ['delivery_inside_dhaka', 'delivery_outside_dhaka', 'free_delivery_threshold']
    );
    const deliveryConfig = Object.fromEntries(deliverySettings.map(setting => [setting.key, Number(setting.value)]));
    const deliveryThreshold = Number.isFinite(deliveryConfig.free_delivery_threshold)
      ? deliveryConfig.free_delivery_threshold : 10000;
    const deliveryFee = subtotal >= deliveryThreshold
      ? 0
      : customer.area === 'dhaka'
        ? Number.isFinite(deliveryConfig.delivery_inside_dhaka) ? deliveryConfig.delivery_inside_dhaka : 100
        : Number.isFinite(deliveryConfig.delivery_outside_dhaka) ? deliveryConfig.delivery_outside_dhaka : 150;
    const grandTotal = subtotal + deliveryFee;
    const orderId = makeReference('RABD', 8);
    const now = new Date().toISOString();
    const cleanCustomer = {
      name: customer.name.trim(),
      phone: customer.phone.trim(),
      altPhone: customer.altPhone ? customer.altPhone.trim() : '',
      area: customer.area,
      address: customer.address.trim(),
      notes: customer.notes ? customer.notes.trim() : ''
    };

    await inTransaction(async () => {
      await run(`
        INSERT INTO orders (
          order_id, date, customer_name, customer_phone, customer_alt_phone,
          customer_area, customer_address, customer_notes, payment_method,
          items_json, subtotal, delivery_fee, grand_total, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        orderId,
        now,
        cleanCustomer.name,
        cleanCustomer.phone,
        cleanCustomer.altPhone,
        cleanCustomer.area,
        cleanCustomer.address,
        cleanCustomer.notes,
        paymentMethod,
        JSON.stringify(normalizedItems),
        subtotal,
        deliveryFee,
        grandTotal,
        'pending',
        now
      ]);
      await run(
        'INSERT INTO analytics_events (event_type, target_id, path, referrer, created_at) VALUES (?, ?, ?, ?, ?)',
        ['order_submit', orderId, '/checkout', '', now]
      );
    });

    res.status(201).json({
      success: true,
      orderId,
      items: normalizedItems,
      subtotal,
      deliveryFee,
      grandTotal,
      message: 'Order recorded centrally in ResAir BD system'
    });
  } catch (err) {
    console.error('Submit order error:', err);
    res.status(500).json({ error: 'Failed to record order' });
  }
});

router.get('/orders', requireAuth, requireRole('owner', 'staff'), async (req, res) => {
  try {
    const filters = parseListQuery(req.query, orderStatuses);
    if (filters.error) return res.status(400).json({ error: filters.error });
    const where = [];
    const params = [];
    if (filters.status !== 'all') {
      where.push('status = ?');
      params.push(filters.status);
    }
    applySearch(where, params, filters.q, ['order_id', 'customer_name', 'customer_phone']);
    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = await get(`SELECT COUNT(*) AS total FROM orders ${whereSQL}`, params);
    const orders = await all(
      `SELECT * FROM orders ${whereSQL} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, filters.limit, (filters.page - 1) * filters.limit]
    );
    res.json({
      orders: orders.map(getOrder),
      total: countRow.total,
      page: filters.page,
      limit: filters.limit,
      totalPages: Math.ceil(countRow.total / filters.limit)
    });
  } catch (err) {
    console.error('Fetch orders error:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

router.get('/orders/:id', requireAuth, requireRole('owner', 'staff'), async (req, res) => {
  try {
    const order = await get('SELECT * FROM orders WHERE id = ? OR order_id = ?', [req.params.id, req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order: getOrder(order) });
  } catch (err) {
    console.error('Fetch order details error:', err);
    res.status(500).json({ error: 'Failed to fetch order details' });
  }
});

router.patch('/orders/:id/status', requireAuth, requireRole('owner', 'staff'), async (req, res) => {
  try {
    const status = req.body?.status;
    if (!orderStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid order status' });
    }
    const order = await get('SELECT * FROM orders WHERE id = ? OR order_id = ?', [req.params.id, req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    await run('UPDATE orders SET status = ? WHERE id = ?', [status, order.id]);
    await logAudit(req.user, 'UPDATE_ORDER_STATUS', `Changed status of Order ${order.order_id} to ${status}`);
    res.json({ success: true, message: `Order status updated to ${status}` });
  } catch (err) {
    console.error('Update order status error:', err);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

router.post('/bookings', limitPublicSubmissions, async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Booking data must be an object' });
    }
    const { type, name, phone, address, notes = '' } = body;
    if (!text(type, 160, { required: true }) ||
        !text(name, 120, { required: true }) ||
        !isPhoneNumber(phone) ||
        !text(address, 1000, { required: true }) ||
        !text(notes, 2000)) {
      return res.status(400).json({ error: 'Booking details are invalid' });
    }

    const bookingId = makeReference('RENT', 7);
    const now = new Date().toISOString();
    await inTransaction(async () => {
      await run(`
        INSERT INTO service_bookings (
          booking_id, type, customer_name, customer_phone, customer_address, details, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [bookingId, type.trim(), name.trim(), phone.trim(), address.trim(), notes.trim(), 'new', now]);
      await run(
        'INSERT INTO analytics_events (event_type, target_id, path, referrer, created_at) VALUES (?, ?, ?, ?, ?)',
        ['rental_booking', bookingId, '/rental', '', now]
      );
    });
    res.status(201).json({
      success: true,
      bookingId,
      message: 'Rental request recorded successfully'
    });
  } catch (err) {
    console.error('Submit booking error:', err);
    res.status(500).json({ error: 'Failed to save rental booking' });
  }
});

router.get('/bookings', requireAuth, requireRole('owner', 'staff'), async (req, res) => {
  try {
    const filters = parseListQuery(req.query, bookingStatuses);
    if (filters.error) return res.status(400).json({ error: filters.error });
    const where = [];
    const params = [];
    if (filters.status !== 'all') {
      where.push('status = ?');
      params.push(filters.status);
    }
    applySearch(where, params, filters.q, ['booking_id', 'type', 'customer_name', 'customer_phone']);
    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countRow = await get(`SELECT COUNT(*) AS total FROM service_bookings ${whereSQL}`, params);
    const bookings = await all(
      `SELECT * FROM service_bookings ${whereSQL} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, filters.limit, (filters.page - 1) * filters.limit]
    );
    res.json({
      bookings: bookings.map(getBooking),
      total: countRow.total,
      page: filters.page,
      limit: filters.limit,
      totalPages: Math.ceil(countRow.total / filters.limit)
    });
  } catch (err) {
    console.error('Fetch bookings error:', err);
    res.status(500).json({ error: 'Failed to fetch service requests' });
  }
});

router.patch('/bookings/:id/status', requireAuth, requireRole('owner', 'staff'), async (req, res) => {
  try {
    const status = req.body?.status;
    if (!bookingStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid booking status' });
    }
    const booking = await get(
      'SELECT * FROM service_bookings WHERE id = ? OR booking_id = ?',
      [req.params.id, req.params.id]
    );
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    await run('UPDATE service_bookings SET status = ? WHERE id = ?', [status, booking.id]);
    await logAudit(req.user, 'UPDATE_BOOKING_STATUS', `Updated booking ${booking.booking_id} status to ${status}`);
    res.json({ success: true, message: `Booking status updated to ${status}` });
  } catch (err) {
    console.error('Update booking status error:', err);
    res.status(500).json({ error: 'Failed to update booking status' });
  }
});

module.exports = router;
