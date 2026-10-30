const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { get, run, all } = require('../db/database');
const { requireAuth, requireRole, logAudit } = require('./auth');

function formatProduct(row) {
  return {
    id: row.id,
    uid: row.uid,
    name: row.name,
    category: row.category,
    price: Number(row.price),
    originalPrice: Number(row.original_price ?? row.price),
    image: row.image || 'assets/logo-white-bg.png',
    link: row.link || '#',
    rating: Number(row.rating || 4.8),
    reviews: Number(row.reviews || 12),
    inStock: Boolean(row.in_stock),
    badge: row.badge || '',
    description: row.description || '',
    specs: row.specs ? JSON.parse(row.specs) : [],
    active: row.is_active !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function validateProductInput(body, partial = false) {
  const errors = [];
  const has = key => Object.prototype.hasOwnProperty.call(body, key);
  const required = ['name', 'category', 'price'];

  if (!partial) {
    for (const key of required) {
      if (!has(key)) errors.push(`${key} is required`);
    }
  }

  if (has('name') && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 240)) {
    errors.push('Name must be between 1 and 240 characters');
  }
  if (has('category') && (typeof body.category !== 'string' || !body.category.trim() || body.category.trim().length > 120)) {
    errors.push('Category must be between 1 and 120 characters');
  }
  for (const key of ['price', 'originalPrice']) {
    if (has(key) && (!Number.isFinite(Number(body[key])) || Number(body[key]) < 0 || Number(body[key]) > 1000000000)) {
      errors.push(`${key} must be a non-negative number`);
    }
  }
  if (has('image') && !isSafeAssetPath(body.image)) {
    errors.push('Image must point to a local storefront asset');
  }
  if (has('link') && (typeof body.link !== 'string' || body.link.length > 2000 ||
      /^(?:javascript|data|vbscript):/i.test(body.link.trim()) ||
      body.link.trim().startsWith('//'))) {
    errors.push('Product link must be a safe local or HTTPS URL');
  }
  for (const key of ['badge', 'description']) {
    if (has(key) && (typeof body[key] !== 'string' || body[key].length > (key === 'badge' ? 100 : 20000))) {
      errors.push(`${key} must be text within the allowed length`);
    }
  }
  if (has('inStock') && typeof body.inStock !== 'boolean') {
    errors.push('inStock must be true or false');
  }
  if (has('specs') && (!Array.isArray(body.specs) ||
      body.specs.length > 50 ||
      body.specs.some(spec => typeof spec !== 'string' || spec.length > 500))) {
    errors.push('Specs must be a list of up to 50 text items');
  }
  if (Number.isFinite(Number(body.price)) && Number.isFinite(Number(body.originalPrice)) &&
      Number(body.originalPrice) < Number(body.price)) {
    errors.push('Original price cannot be lower than the current price');
  }

  return errors;
}

function isSafeAssetPath(value) {
  if (typeof value !== 'string' || value.length > 1000 || value.includes('\\') ||
      value.includes('\0') || value.startsWith('/')) return false;
  if (!value) return true;
  const allowedRoot = value.startsWith('assets/') || value.startsWith('wp-content/uploads/');
  return allowedRoot && !value.split('/').includes('..');
}

async function categoryExists(name) {
  return Boolean(await get('SELECT id FROM categories WHERE name = ?', [name]));
}

async function getNextProductIdentifiers() {
  const rows = await all('SELECT id, uid FROM products');
  let maxId = 21600;
  let maxUid = 222;
  for (const row of rows) {
    const idValue = Number(row.id);
    const uidMatch = /^p_(\d+)$/.exec(row.uid);
    if (Number.isSafeInteger(idValue)) maxId = Math.max(maxId, idValue);
    if (uidMatch) maxUid = Math.max(maxUid, Number(uidMatch[1]));
  }
  return { id: String(maxId + 1), uid: `p_${maxUid + 1}` };
}

// Setup image upload directory
const UPLOAD_DIR = path.join(__dirname, '..', 'assets', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const allowed = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp'
    };
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed[ext] === file.mimetype) {
      cb(null, true);
    } else {
      const error = new Error('Only PNG, JPEG, and WebP image files are allowed');
      error.status = 400;
      cb(error);
    }
  }
});

// Image Upload Endpoint
router.post('/upload', requireAuth, requireRole('owner'), upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image file uploaded' });
  }

  const processedFilename = `${crypto.randomUUID()}.webp`;
  const processedPath = path.join(UPLOAD_DIR, processedFilename);
  try {
    const metadata = await sharp(req.file.path).metadata();
    if (!metadata.width || !metadata.height ||
        metadata.width * metadata.height > 40000000 ||
        !['png', 'jpeg', 'webp'].includes(metadata.format)) {
      await fs.promises.unlink(req.file.path);
      return res.status(400).json({ error: 'Uploaded file is not a supported image' });
    }

    await sharp(req.file.path)
      .rotate()
      .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(processedPath);
    await fs.promises.unlink(req.file.path);
  } catch (err) {
    await Promise.all([req.file.path, processedPath].map(filePath =>
      fs.promises.unlink(filePath).catch(unlinkError => {
        if (unlinkError.code !== 'ENOENT') console.error('Failed to remove uploaded image:', unlinkError);
      })
    ));
    console.error('Image upload processing failed:', err);
    return res.status(400).json({ error: 'Uploaded file could not be processed as an image' });
  }

  const relativePath = `assets/uploads/${processedFilename}`;
  res.json({ success: true, url: relativePath });
});

// GET /api/products (Public & Admin)
router.get('/products', async (req, res) => {
  try {
    const { all: returnAll, q, category, inStock, page = 1, limit = 20, sort = 'default' } = req.query;

    // Fast path: storefront requests all products
    if (returnAll === 'true') {
      const rows = await all('SELECT * FROM products WHERE is_active = 1 ORDER BY rowid ASC');
      const formatted = rows.map(formatProduct);
      return res.json({ products: formatted, total: formatted.length });
    }

    // Admin / Paginated path
    let whereClauses = [];
    let params = [];

    if (q && q.trim()) {
      whereClauses.push('(name LIKE ? OR category LIKE ? OR id LIKE ? OR uid LIKE ?)');
      const term = `%${q.trim()}%`;
      params.push(term, term, term, term);
    }

    if (category && category !== 'all') {
      whereClauses.push('category = ?');
      params.push(category);
    }

    if (inStock !== undefined && inStock !== '') {
      whereClauses.push('in_stock = ?');
      params.push(inStock === '1' || inStock === 'true' ? 1 : 0);
    }

    whereClauses.unshift('is_active = 1');
    const whereSQL = `WHERE ${whereClauses.join(' AND ')}`;

    let orderSQL = 'ORDER BY rowid DESC';
    if (sort === 'price_asc') orderSQL = 'ORDER BY price ASC';
    else if (sort === 'price_desc') orderSQL = 'ORDER BY price DESC';
    else if (sort === 'name_asc') orderSQL = 'ORDER BY name ASC';

    const countRow = await get(`SELECT COUNT(*) as total FROM products ${whereSQL}`, params);
    const total = countRow ? countRow.total : 0;

    const parsedPage = Number.parseInt(page, 10);
    const parsedLimit = Number.parseInt(limit, 10);
    if (!Number.isSafeInteger(parsedPage) || parsedPage < 1 ||
        !Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return res.status(400).json({ error: 'Page and limit must be positive integers; limit cannot exceed 100' });
    }
    const offset = (parsedPage - 1) * parsedLimit;
    const queryParams = [...params, parsedLimit, offset];

    const rows = await all(`SELECT * FROM products ${whereSQL} ${orderSQL} LIMIT ? OFFSET ?`, queryParams);

    const products = rows.map(formatProduct);

    res.json({
      products,
      total,
      page: parsedPage,
      totalPages: Math.ceil(total / parsedLimit)
    });
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

router.get('/products/manage', requireAuth, requireRole('owner', 'staff'), async (req, res) => {
  try {
    const { q = '', category, stock = 'all', status = 'active', sort = 'newest' } = req.query;
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isSafeInteger(page) || page < 1 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ error: 'Invalid page or page size' });
    }
    if (!['active', 'archived', 'all'].includes(status)) {
      return res.status(400).json({ error: 'Invalid product status filter' });
    }
    if (!['all', 'in-stock', 'out-of-stock'].includes(stock)) {
      return res.status(400).json({ error: 'Invalid stock filter' });
    }

    const where = [];
    const params = [];
    if (status !== 'all') {
      where.push('is_active = ?');
      params.push(status === 'active' ? 1 : 0);
    }
    if (typeof q === 'string' && q.trim()) {
      const term = `%${q.trim().slice(0, 120)}%`;
      where.push('(name LIKE ? OR category LIKE ? OR id LIKE ? OR uid LIKE ?)');
      params.push(term, term, term, term);
    }
    if (typeof category === 'string' && category && category !== 'all') {
      where.push('category = ?');
      params.push(category);
    }
    if (stock !== 'all') {
      where.push('in_stock = ?');
      params.push(stock === 'in-stock' ? 1 : 0);
    }
    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const orderSQL = {
      newest: 'ORDER BY rowid DESC',
      oldest: 'ORDER BY rowid ASC',
      price_asc: 'ORDER BY price ASC, name ASC',
      price_desc: 'ORDER BY price DESC, name ASC',
      name_asc: 'ORDER BY name COLLATE NOCASE ASC'
    }[sort];
    if (!orderSQL) return res.status(400).json({ error: 'Invalid sort order' });

    const countRow = await get(`SELECT COUNT(*) AS total FROM products ${whereSQL}`, params);
    const products = await all(
      `SELECT * FROM products ${whereSQL} ${orderSQL} LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    res.json({
      products: products.map(formatProduct),
      total: countRow.total,
      page,
      limit,
      totalPages: Math.ceil(countRow.total / limit)
    });
  } catch (err) {
    console.error('Admin product query failed:', err);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// GET single product
router.get('/products/:id', async (req, res) => {
  try {
    const r = await get(
      'SELECT * FROM products WHERE (id = ? OR uid = ?) AND is_active = 1',
      [req.params.id, req.params.id]
    );
    if (!r) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json({ product: formatProduct(r) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// CREATE Product (Auth required)
router.post('/products', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Product data must be an object' });
    }
    const {
      name,
      category,
      price,
      originalPrice,
      image,
      link,
      inStock = true,
      badge = '',
      description = '',
      specs = []
    } = req.body;

    const errors = validateProductInput(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('. ') });
    const cleanName = name.trim();
    const cleanCategory = category.trim();
    if (!await categoryExists(cleanCategory)) {
      return res.status(400).json({ error: 'Choose an existing category' });
    }
    const numPrice = Number(price);
    const numOrig = originalPrice === undefined ? numPrice : Number(originalPrice);
    const now = new Date().toISOString();
    const { id: newId, uid: newUid } = await getNextProductIdentifiers();

    await run(`
      INSERT INTO products (
        id, uid, name, category, price, original_price, image, link,
        rating, reviews, in_stock, is_active, badge, description, specs, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `, [
      newId,
      newUid,
      cleanName,
      cleanCategory,
      numPrice,
      numOrig,
      image ? image.trim() : 'assets/logo-white-bg.png',
      link ? link.trim() : '#',
      4.8,
      12,
      inStock ? 1 : 0,
      badge ? badge.trim() : '',
      description ? description.trim() : '',
      JSON.stringify(specs),
      now
    ]);

    await logAudit(req.user, 'CREATE_PRODUCT', `Created product "${cleanName}" (ID: ${newId})`);
    res.status(201).json({ success: true, id: newId, uid: newUid, message: 'Product created successfully' });
  } catch (err) {
    console.error('Create product error:', err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// UPDATE Product (Auth required)
router.put('/products/:id', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await get('SELECT * FROM products WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Product not found' });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Product data must be an object' });
    }

    const {
      name,
      category,
      price,
      originalPrice,
      image,
      link,
      inStock,
      badge,
      description,
      specs
    } = req.body;

    const errors = validateProductInput(req.body, true);
    if (errors.length) return res.status(400).json({ error: errors.join('. ') });
    if (category !== undefined && !await categoryExists(category.trim())) {
      return res.status(400).json({ error: 'Choose an existing category' });
    }
    const numPrice = price !== undefined ? Number(price) : existing.price;
    const numOrig = originalPrice !== undefined ? Number(originalPrice) : existing.original_price;
    if (numOrig < numPrice) {
      return res.status(400).json({ error: 'Original price cannot be lower than the current price' });
    }
    const stockVal = inStock !== undefined ? (inStock ? 1 : 0) : existing.in_stock;
    const specsJson = specs !== undefined ? JSON.stringify(specs) : existing.specs;
    const now = new Date().toISOString();

    await run(`
      UPDATE products SET
        name = ?,
        category = ?,
        price = ?,
        original_price = ?,
        image = ?,
        link = ?,
        in_stock = ?,
        badge = ?,
        description = ?,
        specs = ?,
        updated_at = ?
      WHERE id = ?
    `, [
      name !== undefined ? name.trim() : existing.name,
      category !== undefined ? category.trim() : existing.category,
      numPrice,
      numOrig,
      image !== undefined ? image.trim() : existing.image,
      link !== undefined ? link.trim() : existing.link,
      stockVal,
      badge !== undefined ? badge.trim() : existing.badge,
      description !== undefined ? description.trim() : existing.description,
      specsJson,
      now,
      id
    ]);

    await logAudit(req.user, 'UPDATE_PRODUCT', `Updated product "${existing.name}" (ID: ${id})`);
    res.json({ success: true, message: 'Product updated successfully' });
  } catch (err) {
    console.error('Update product error:', err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Archive products instead of permanently deleting catalog records.
router.patch('/products/:id/archive', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await get('SELECT * FROM products WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Product not found' });
    }

    if (!existing.is_active) return res.status(409).json({ error: 'Product is already archived' });
    await run('UPDATE products SET is_active = 0, updated_at = ? WHERE id = ?', [new Date().toISOString(), id]);
    await logAudit(req.user, 'ARCHIVE_PRODUCT', `Archived product "${existing.name}" (ID: ${id})`);
    res.json({ success: true, message: 'Product moved to archive' });
  } catch (err) {
    console.error('Archive product error:', err);
    res.status(500).json({ error: 'Failed to archive product' });
  }
});

router.patch('/products/:id/restore', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await get('SELECT * FROM products WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    if (existing.is_active) return res.status(409).json({ error: 'Product is already active' });
    await run('UPDATE products SET is_active = 1, updated_at = ? WHERE id = ?', [new Date().toISOString(), id]);
    await logAudit(req.user, 'RESTORE_PRODUCT', `Restored product "${existing.name}" (ID: ${id})`);
    res.json({ success: true, message: 'Product restored to the catalog' });
  } catch (err) {
    console.error('Restore product error:', err);
    res.status(500).json({ error: 'Failed to restore product' });
  }
});

router.delete('/products/:id', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const existing = await get('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Product not found' });
    if (!existing.is_active) return res.status(409).json({ error: 'Product is already archived' });
    await run('UPDATE products SET is_active = 0, updated_at = ? WHERE id = ?', [
      new Date().toISOString(),
      req.params.id
    ]);
    await logAudit(req.user, 'ARCHIVE_PRODUCT', `Archived product "${existing.name}" (ID: ${req.params.id})`);
    res.json({ success: true, message: 'Product moved to archive' });
  } catch (err) {
    console.error('Archive product error:', err);
    res.status(500).json({ error: 'Failed to archive product' });
  }
});

// GET Categories
router.get('/categories', async (req, res) => {
  try {
    const categories = await all(`
      SELECT c.id, c.name, c.image, c.desc,
        COUNT(p.id) AS count
      FROM categories c
      LEFT JOIN products p ON p.category = c.name AND p.is_active = 1
      GROUP BY c.id
      ORDER BY c.id ASC
    `);
    res.json({ categories });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// CREATE Category
router.post('/categories', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Category data must be an object' });
    }
    const { name, image, desc } = req.body;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
      return res.status(400).json({ error: 'Category name must be between 1 and 120 characters' });
    }
    if (image !== undefined && !isSafeAssetPath(image)) {
      return res.status(400).json({ error: 'Category image must point to a local storefront asset' });
    }
    if (desc !== undefined && (typeof desc !== 'string' || desc.length > 2000)) {
      return res.status(400).json({ error: 'Category description must be under 2000 characters' });
    }

    const existing = await get('SELECT id FROM categories WHERE name = ?', [name.trim()]);
    if (existing) {
      return res.status(400).json({ error: 'Category already exists' });
    }

    const result = await run(
      'INSERT INTO categories (name, image, desc, count) VALUES (?, ?, ?, 0)',
      [name.trim(), image ? image.trim() : 'assets/logo-white-bg.png', desc ? desc.trim() : '']
    );

    await logAudit(req.user, 'CREATE_CATEGORY', `Created category "${name}"`);
    res.status(201).json({ success: true, id: result.id, message: 'Category created successfully' });
  } catch (err) {
    console.error('Create category error:', err);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

// UPDATE Category
router.put('/categories/:id', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Category data must be an object' });
    }
    const { name, image, desc } = req.body;
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 120)) {
      return res.status(400).json({ error: 'Category name must be between 1 and 120 characters' });
    }
    if (image !== undefined && !isSafeAssetPath(image)) {
      return res.status(400).json({ error: 'Category image must point to a local storefront asset' });
    }
    if (desc !== undefined && (typeof desc !== 'string' || desc.length > 2000)) {
      return res.status(400).json({ error: 'Category description must be under 2000 characters' });
    }
    const existing = await get('SELECT * FROM categories WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const nextName = name !== undefined ? name.trim() : existing.name;
    const duplicate = nextName === existing.name
      ? null
      : await get('SELECT id FROM categories WHERE name = ? AND id != ?', [nextName, id]);
    if (duplicate) return res.status(409).json({ error: 'Category name already exists' });

    await run('BEGIN IMMEDIATE');
    try {
      await run(
        'UPDATE categories SET name = ?, image = ?, desc = ? WHERE id = ?',
        [
          nextName,
          image !== undefined ? image.trim() : existing.image,
          desc !== undefined ? desc.trim() : existing.desc,
          id
        ]
      );
      if (nextName !== existing.name) {
        await run('UPDATE products SET category = ?, updated_at = ? WHERE category = ?', [
          nextName,
          new Date().toISOString(),
          existing.name
        ]);
      }
      await logAudit(req.user, 'UPDATE_CATEGORY', `Updated category "${existing.name}"`);
      await run('COMMIT');
    } catch (err) {
      await run('ROLLBACK');
      throw err;
    }

    res.json({ success: true, message: 'Category updated successfully' });
  } catch (err) {
    console.error('Update category error:', err);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// DELETE Category
router.delete('/categories/:id', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await get('SELECT * FROM categories WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const assigned = await get('SELECT COUNT(*) AS count FROM products WHERE category = ?', [existing.name]);
    if (assigned.count > 0) {
      return res.status(409).json({
        error: 'This category still has products. Move those products before deleting the category.'
      });
    }

    await run('DELETE FROM categories WHERE id = ?', [id]);
    await logAudit(req.user, 'DELETE_CATEGORY', `Deleted category "${existing.name}"`);
    res.json({ success: true, message: 'Category deleted successfully' });
  } catch (err) {
    console.error('Delete category error:', err);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

module.exports = router;
