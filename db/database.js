const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = process.env.RESAIRBD_DB_PATH || path.join(DATA_DIR, 'resairbd.db');
const db = new sqlite3.Database(DB_PATH);

// Helper functions for promise-based queries
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function initDB() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT
    )
  `);

  const userColumns = await all('PRAGMA table_info(users)');
  if (!userColumns.some(column => column.name === 'is_active')) {
    await run('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
  }

  await run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const legacyAccountMigration = await get(
    'SELECT name FROM schema_migrations WHERE name = ?',
    ['disable-seeded-default-accounts']
  );
  if (!legacyAccountMigration) {
    await run("UPDATE users SET is_active = 0 WHERE username IN ('admin', 'staff')");
    await run(
      'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
      ['disable-seeded-default-accounts', new Date().toISOString()]
    );
  }

  await run(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      uid TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price REAL NOT NULL,
      original_price REAL,
      image TEXT NOT NULL,
      link TEXT,
      rating REAL DEFAULT 4.8,
      reviews INTEGER DEFAULT 12,
      in_stock INTEGER DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      badge TEXT DEFAULT '',
      description TEXT,
      specs TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
    )
  `);

  const productColumns = await all('PRAGMA table_info(products)');
  if (!productColumns.some(column => column.name === 'is_active')) {
    await run('ALTER TABLE products ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
  }

  await run(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      image TEXT,
      desc TEXT,
      count INTEGER DEFAULT 0
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT UNIQUE NOT NULL,
      date TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_alt_phone TEXT,
      customer_area TEXT,
      customer_address TEXT NOT NULL,
      customer_notes TEXT,
      payment_method TEXT NOT NULL,
      items_json TEXT NOT NULL,
      subtotal REAL NOT NULL,
      delivery_fee REAL NOT NULL,
      grand_total REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS service_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_address TEXT NOT NULL,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS hero_slides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slide_order INTEGER NOT NULL DEFAULT 1,
      slide_type TEXT NOT NULL DEFAULT 'content',
      banner_image TEXT,
      banner_link TEXT,
      badge_text TEXT,
      title TEXT,
      subtitle TEXT,
      primary_btn_text TEXT,
      primary_btn_link TEXT,
      secondary_btn_text TEXT,
      secondary_btn_link TEXT,
      bg_gradient TEXT,
      is_active INTEGER DEFAULT 1
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      target_id TEXT,
      path TEXT,
      referrer TEXT,
      created_at TEXT NOT NULL
    )
  `);

  console.log('Database tables verified and initialized.');
}

module.exports = {
  db,
  run,
  get,
  all,
  initDB
};
