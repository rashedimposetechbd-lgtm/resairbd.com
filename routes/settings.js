const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { get, run, all } = require('../db/database');
const { requireAuth, requireRole, logAudit } = require('./auth');

const settingLimits = {
  site_name: 120,
  tagline: 240,
  hotline: 32,
  secondary_phone: 32,
  whatsapp: 32,
  email: 254,
  address: 500,
  logo_url: 1000,
  delivery_inside_dhaka: 10,
  delivery_outside_dhaka: 10,
  free_delivery_threshold: 12,
  powered_by_name: 120,
  powered_by_url: 500
};
const publicSettingKeys = [
  'site_name',
  'tagline',
  'hotline',
  'secondary_phone',
  'whatsapp',
  'email',
  'address',
  'logo_url',
  'delivery_inside_dhaka',
  'delivery_outside_dhaka',
  'free_delivery_threshold',
  'powered_by_name',
  'powered_by_url'
];

function validateSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return 'Settings object is required';
  }
  const entries = Object.entries(settings);
  if (!entries.length || entries.length > Object.keys(settingLimits).length) {
    return 'Provide at least one supported setting';
  }

  for (const [key, value] of entries) {
    if (!Object.hasOwn(settingLimits, key)) return `Unsupported setting: ${key}`;
    if (typeof value !== 'string' || value.trim().length > settingLimits[key]) {
      return `${key} must be text within ${settingLimits[key]} characters`;
    }
    if (['delivery_inside_dhaka', 'delivery_outside_dhaka', 'free_delivery_threshold'].includes(key) &&
        (!/^\d+(?:\.\d{1,2})?$/.test(value.trim()) || Number(value) > 10000000)) {
      return `${key} must be a non-negative amount`;
    }
    if (key === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
      return 'Email address is invalid';
    }
    if (['hotline', 'secondary_phone', 'whatsapp'].includes(key) && value) {
      const digits = value.replace(/\D/g, '');
      if (!/^[+0-9()\-\s]{6,32}$/.test(value.trim()) || digits.length < 7 || digits.length > 15) {
        return `${key} must be a valid phone number`;
      }
    }
    if (key === 'logo_url' && value &&
        (!value.startsWith('assets/') || value.includes('\\') || value.split('/').includes('..'))) {
      return 'Logo must point to a local asset';
    }
    if (key === 'powered_by_url' && value) {
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) return 'Powered-by URL must use HTTP or HTTPS';
      } catch {
        return 'Powered-by URL must be a valid URL';
      }
    }
  }
  return null;
}

router.get('/site-config', async (req, res) => {
  try {
    const placeholders = publicSettingKeys.map(() => '?').join(', ');
    const rows = await all(
      `SELECT key, value FROM site_settings WHERE key IN (${placeholders})`,
      publicSettingKeys
    );
    const settings = {};
    for (const row of rows) settings[row.key] = row.value;
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ settings });
  } catch (err) {
    console.error('Fetch public site settings error:', err);
    res.status(500).json({ error: 'Failed to fetch public site settings' });
  }
});

async function saveSettings(settings) {
  await run('BEGIN IMMEDIATE');
  try {
    for (const [key, value] of Object.entries(settings)) {
      await run(
        'INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, value.trim()]
      );
    }
    await run('COMMIT');
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  }
}

// Multer storage for logo
const LOGO_DIR = path.join(__dirname, '..', 'assets');
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, LOGO_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, `logo-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
  }
});

const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp'
    };
    if (allowed[ext] === file.mimetype) {
      cb(null, true);
    } else {
      const error = new Error('Only PNG, JPEG, and WebP logo files are allowed');
      error.status = 400;
      cb(error);
    }
  }
});

// GET /api/settings
router.get('/settings', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const rows = await all('SELECT key, value FROM site_settings');
    const settings = {};
    rows.forEach(r => {
      settings[r.key] = r.value;
    });
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /api/settings - Update settings (Auth required)
router.put('/settings', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const settings = req.body?.settings;
    const validationError = validateSettings(settings);
    if (validationError) return res.status(400).json({ error: validationError });
    await saveSettings(settings);
    await logAudit(req.user, 'UPDATE_SETTINGS', 'Updated site configuration settings');
    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (err) {
    console.error('Update settings error:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// POST /api/settings/logo - Upload new logo & auto-generate favicons
router.post('/settings/logo', requireAuth, requireRole('owner'), logoUpload.single('logo'), async (req, res) => {
  let safePath;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No logo image uploaded' });
    }

    const uploadedPath = req.file.path;
    const safeFilename = `logo-${crypto.randomUUID()}.webp`;
    safePath = path.join(LOGO_DIR, safeFilename);
    let metadata;
    try {
      metadata = await sharp(uploadedPath).metadata();
    } catch (imageError) {
      await fs.promises.unlink(uploadedPath);
      return res.status(400).json({ error: 'Uploaded file is not a supported image' });
    }
    if (!metadata.width || !metadata.height ||
        metadata.width * metadata.height > 40000000 ||
        !['png', 'jpeg', 'webp'].includes(metadata.format)) {
      await fs.promises.unlink(uploadedPath);
      return res.status(400).json({ error: 'Uploaded file is not a supported image' });
    }

    await sharp(uploadedPath)
      .rotate()
      .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(safePath);
    await fs.promises.unlink(uploadedPath);

    const relativeLogoPath = `assets/${safeFilename}`;
    const fav32Path = path.join(LOGO_DIR, 'favicon-32.png');
    const fav192Path = path.join(LOGO_DIR, 'favicon-192.png');
    await sharp(safePath).resize(32, 32).png().toFile(fav32Path);
    await sharp(safePath).resize(192, 192).png().toFile(fav192Path);

    // Save in site_settings
    await saveSettings({ logo_url: relativeLogoPath });
    await logAudit(req.user, 'UPLOAD_LOGO', `Uploaded new logo: ${relativeLogoPath}`);

    res.json({
      success: true,
      logoUrl: relativeLogoPath,
      message: 'Logo updated and favicons generated successfully'
    });
  } catch (err) {
    console.error('Logo upload error:', err);
    await Promise.all([req.file && req.file.path, safePath].filter(Boolean).map(filePath =>
      fs.promises.unlink(filePath).catch(unlinkError => {
        if (unlinkError.code !== 'ENOENT') console.error('Failed to remove uploaded logo:', unlinkError);
      })
    ));
    res.status(500).json({ error: 'Failed to process logo upload' });
  }
});

module.exports = router;
