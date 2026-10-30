const express = require('express');
const router = express.Router();
const { get, run, all } = require('../db/database');
const { requireAuth, requireRole, logAudit } = require('./auth');

const textFields = {
  bannerLink: 2000,
  badgeText: 160,
  title: 240,
  subtitle: 2000,
  primaryBtnText: 80,
  primaryBtnLink: 2000,
  secondaryBtnText: 80,
  secondaryBtnLink: 2000
};

function isSafeAssetPath(value) {
  return typeof value === 'string' && value.length <= 1000 &&
    !value.includes('\\') && !value.includes('\0') && !value.startsWith('/') &&
    (value.startsWith('assets/') || value.startsWith('wp-content/uploads/')) &&
    !value.split('/').includes('..');
}

function isSafeLink(value, allowRentalAction = false) {
  if (typeof value !== 'string' || value.length > 2000) return false;
  const link = value.trim();
  if (!link) return true;
  if (allowRentalAction && /^javascript:openRentalModal\("(Oxygen Cylinder|Oxygen Concentrator|BiPAP CPAP|Hospital Bed|Pet Oxygen)"\)$/i.test(link)) {
    return true;
  }
  if (/^(?:javascript|data|vbscript):/i.test(link) || link.startsWith('//')) return false;
  return /^(?:https:\/\/|http:\/\/|tel:|mailto:|#|\/(?!\/)|[a-z0-9][a-z0-9/_-]*$)/i.test(link);
}

function validateSlide(body, partial = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['Slide data must be an object'];
  }
  const errors = [];
  const has = key => Object.prototype.hasOwnProperty.call(body, key);
  if (!partial && has('slideType') && !['content', 'image_banner'].includes(body.slideType)) {
    errors.push('Slide type must be content or image_banner');
  }
  if (!partial && !has('slideType')) errors.push('Slide type is required');
  if (!partial && !has('title')) errors.push('Slide title is required');
  if (has('slideOrder') &&
      (!Number.isSafeInteger(Number(body.slideOrder)) || Number(body.slideOrder) < 1 || Number(body.slideOrder) > 1000)) {
    errors.push('Slide order must be a positive integer');
  }
  if (has('slideType') && !['content', 'image_banner'].includes(body.slideType)) {
    errors.push('Slide type must be content or image_banner');
  }
  if (has('bannerImage') && body.bannerImage !== '' && !isSafeAssetPath(body.bannerImage)) {
    errors.push('Slide image must point to a local storefront asset');
  }
  if (!partial && body.slideType === 'image_banner' && !body.bannerImage) {
    errors.push('Image banner slides require an image');
  }
  if (has('title') && typeof body.title === 'string' && !body.title.trim()) {
    errors.push('Slide title cannot be empty');
  }
  for (const [field, maxLength] of Object.entries(textFields)) {
    if (has(field) && (typeof body[field] !== 'string' || body[field].length > maxLength)) {
      errors.push(`${field} must be text within ${maxLength} characters`);
    }
  }
  if (has('bannerLink') && !isSafeLink(body.bannerLink)) errors.push('Banner link must be a safe URL');
  for (const field of ['primaryBtnLink', 'secondaryBtnLink']) {
    if (has(field) && !isSafeLink(body[field], true)) errors.push(`${field} must be a safe URL or supported rental action`);
  }
  if (has('bgGradient') &&
      (typeof body.bgGradient !== 'string' || body.bgGradient.length > 240 ||
       !/^(?:#[0-9a-f]{3,8}|linear-gradient\((?:[a-z0-9.%\s,#()-]+)\))$/i.test(body.bgGradient))) {
    errors.push('Background must be a hex color or a simple linear gradient');
  }
  if (has('isActive') && typeof body.isActive !== 'boolean') {
    errors.push('isActive must be true or false');
  }
  return errors;
}

function toSlide(row) {
  return {
    id: row.id,
    slideOrder: row.slide_order,
    slideType: row.slide_type,
    bannerImage: row.banner_image || '',
    bannerLink: row.banner_link || '',
    badgeText: row.badge_text || '',
    title: row.title || '',
    subtitle: row.subtitle || '',
    primaryBtnText: row.primary_btn_text || '',
    primaryBtnLink: row.primary_btn_link || '',
    secondaryBtnText: row.secondary_btn_text || '',
    secondaryBtnLink: row.secondary_btn_link || '',
    bgGradient: row.bg_gradient || '#ffffff',
    isActive: Boolean(row.is_active)
  };
}

router.get('/sliders', (req, res, next) => {
  if (req.query.all === 'true') return requireAuth(req, res, next);
  next();
}, async (req, res) => {
  try {
    const showAll = req.query.all === 'true';
    if (showAll && !req.user) {
      return res.status(401).json({ error: 'Authentication required to view inactive slides' });
    }
    if (showAll && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Owner access required to view inactive slides' });
    }
    const slides = await all(
      `SELECT * FROM hero_slides ${showAll ? '' : 'WHERE is_active = 1 '}ORDER BY slide_order ASC, id ASC`
    );
    res.json({ slides: slides.map(toSlide) });
  } catch (err) {
    console.error('Fetch slides error:', err);
    res.status(500).json({ error: 'Failed to fetch slides' });
  }
});

router.post('/sliders', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const errors = validateSlide(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join('. ') });
    const body = req.body;
    const maxOrderRow = await get('SELECT MAX(slide_order) AS maxOrder FROM hero_slides');
    const slideOrder = body.slideOrder === undefined
      ? (maxOrderRow?.maxOrder || 0) + 1
      : Number(body.slideOrder);
    const result = await run(`
      INSERT INTO hero_slides (
        slide_order, slide_type, banner_image, banner_link, badge_text, title, subtitle,
        primary_btn_text, primary_btn_link, secondary_btn_text, secondary_btn_link, bg_gradient, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [
      slideOrder,
      body.slideType,
      body.bannerImage || '',
      body.bannerLink?.trim() || '',
      body.badgeText?.trim() || '',
      body.title?.trim() || '',
      body.subtitle?.trim() || '',
      body.primaryBtnText?.trim() || '',
      body.primaryBtnLink?.trim() || '',
      body.secondaryBtnText?.trim() || '',
      body.secondaryBtnLink?.trim() || '',
      body.bgGradient || '#ffffff'
    ]);
    await logAudit(req.user, 'CREATE_SLIDE', `Created hero slide ID ${result.id}`);
    res.status(201).json({ success: true, id: result.id, message: 'Slide created successfully' });
  } catch (err) {
    console.error('Create slide error:', err);
    res.status(500).json({ error: 'Failed to create slide' });
  }
});

router.put('/sliders/:id', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const errors = validateSlide(req.body, true);
    if (errors.length) return res.status(400).json({ error: errors.join('. ') });
    const existing = await get('SELECT * FROM hero_slides WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Slide not found' });
    const body = req.body;
    await run(`
      UPDATE hero_slides SET
        slide_order = ?, slide_type = ?, banner_image = ?, banner_link = ?, badge_text = ?,
        title = ?, subtitle = ?, primary_btn_text = ?, primary_btn_link = ?,
        secondary_btn_text = ?, secondary_btn_link = ?, bg_gradient = ?, is_active = ?
      WHERE id = ?
    `, [
      body.slideOrder === undefined ? existing.slide_order : Number(body.slideOrder),
      body.slideType === undefined ? existing.slide_type : body.slideType,
      body.bannerImage === undefined ? existing.banner_image : body.bannerImage.trim(),
      body.bannerLink === undefined ? existing.banner_link : body.bannerLink.trim(),
      body.badgeText === undefined ? existing.badge_text : body.badgeText.trim(),
      body.title === undefined ? existing.title : body.title.trim(),
      body.subtitle === undefined ? existing.subtitle : body.subtitle.trim(),
      body.primaryBtnText === undefined ? existing.primary_btn_text : body.primaryBtnText.trim(),
      body.primaryBtnLink === undefined ? existing.primary_btn_link : body.primaryBtnLink.trim(),
      body.secondaryBtnText === undefined ? existing.secondary_btn_text : body.secondaryBtnText.trim(),
      body.secondaryBtnLink === undefined ? existing.secondary_btn_link : body.secondaryBtnLink.trim(),
      body.bgGradient === undefined ? existing.bg_gradient : body.bgGradient.trim(),
      body.isActive === undefined ? existing.is_active : body.isActive ? 1 : 0,
      req.params.id
    ]);
    await logAudit(req.user, 'UPDATE_SLIDE', `Updated hero slide ID ${req.params.id}`);
    res.json({ success: true, message: 'Slide updated successfully' });
  } catch (err) {
    console.error('Update slide error:', err);
    res.status(500).json({ error: 'Failed to update slide' });
  }
});

router.delete('/sliders/:id', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const existing = await get('SELECT id FROM hero_slides WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Slide not found' });
    await run('DELETE FROM hero_slides WHERE id = ?', [req.params.id]);
    await logAudit(req.user, 'DELETE_SLIDE', `Deleted hero slide ID ${req.params.id}`);
    res.json({ success: true, message: 'Slide deleted successfully' });
  } catch (err) {
    console.error('Delete slide error:', err);
    res.status(500).json({ error: 'Failed to delete slide' });
  }
});

module.exports = router;
