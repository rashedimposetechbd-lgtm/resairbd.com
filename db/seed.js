const fs = require('fs');
const path = require('path');
const { db, run, get, all, initDB } = require('./database');

async function seed() {
  console.log('--- Starting ResAir BD Database Seeding ---');
  await initDB();

  // Parse index.html for PRODUCTS_DATA and ALL_CATEGORIES_META
  const indexPath = path.join(__dirname, '..', 'index.html');
  const htmlContent = fs.readFileSync(indexPath, 'utf8');

  // Parse PRODUCTS_DATA
  const pMatch = htmlContent.match(/const PRODUCTS_DATA = (\[[\s\S]*?\]);/);
  if (pMatch) {
    const products = JSON.parse(pMatch[1]);
    console.log(`Found ${products.length} products in index.html to migrate.`);

    const count = (await get('SELECT COUNT(*) as count FROM products')).count;
    if (count === 0) {
      const now = new Date().toISOString();
      for (const p of products) {
        await run(`
          INSERT INTO products (
            id, uid, name, category, price, original_price, image, link,
            rating, reviews, in_stock, badge, description, specs, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          String(p.id || ''),
          String(p.uid || ''),
          p.name || '',
          p.category || 'General',
          Number(p.price || 0),
          Number(p.originalPrice || p.price || 0),
          p.image || 'assets/logo-white-bg.png',
          p.link || '#',
          Number(p.rating || 4.8),
          Number(p.reviews || 12),
          p.inStock ? 1 : 0,
          p.badge || '',
          p.description || '',
          JSON.stringify(p.specs || []),
          now
        ]);
      }
      console.log(`Successfully imported ${products.length} products into SQLite.`);
    } else {
      console.log(`Products table already contains ${count} products.`);
    }
  }

  // Parse ALL_CATEGORIES_META
  const cMatch = htmlContent.match(/const ALL_CATEGORIES_META = (\[[\s\S]*?\]);/);
  if (cMatch) {
    const categories = JSON.parse(cMatch[1]);
    const catCount = (await get('SELECT COUNT(*) as count FROM categories')).count;
    if (catCount === 0) {
      for (const c of categories) {
        await run(`
          INSERT INTO categories (name, image, desc, count)
          VALUES (?, ?, ?, ?)
        `, [
          c.name,
          c.image || 'assets/logo-white-bg.png',
          c.desc || '',
          Number(c.count || 0)
        ]);
      }
      console.log(`Successfully imported ${categories.length} categories into SQLite.`);
    } else {
      console.log(`Categories table already contains ${catCount} categories.`);
    }
  }

  // 3. Seed Hero Slides
  const slideCount = (await get('SELECT COUNT(*) as count FROM hero_slides')).count;
  if (slideCount === 0) {
    // Slide 1: Banner Image
    await run(`
      INSERT INTO hero_slides (
        slide_order, slide_type, banner_image, banner_link, badge_text, title, subtitle,
        primary_btn_text, primary_btn_link, secondary_btn_text, secondary_btn_link, bg_gradient, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      1,
      'image_banner',
      'assets/hero-banner-resair.jpg',
      'tel:+8801723002029',
      '',
      'ResAir BD 24/7 Medical Support',
      'We are always here for you',
      'Call Hotline: 01723002029',
      'tel:+8801723002029',
      'Order on WhatsApp',
      'https://wa.me/8801723002029',
      '#ffffff',
      1
    ]);

    // Slide 2: Oxygen Cylinder
    await run(`
      INSERT INTO hero_slides (
        slide_order, slide_type, banner_image, banner_link, badge_text, title, subtitle,
        primary_btn_text, primary_btn_link, secondary_btn_text, secondary_btn_link, bg_gradient, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      2,
      'content',
      'wp-content/uploads/2026/08/Oxygen-Cylinder-Price-in-Bangladesh-1024x1024.png',
      '',
      '🚑 24/7 Fast Emergency Delivery in Dhaka',
      'Medical Oxygen Cylinder & Instant Refill Service',
      '1.4m³, 2.0m³ & 40L certified medical oxygen cylinders delivered within 2 hours with trolley, flowmeter regulator & nasal cannula.',
      'Call Hotline: 01723002029',
      'tel:+8801723002029',
      'Order on WhatsApp',
      'https://wa.me/8801723002029?text=Hello%20ResAirBD,%20I%20need%20Emergency%20Oxygen%20Cylinder%20Delivery',
      'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)',
      1
    ]);

    // Slide 3: Oxygen Concentrator
    await run(`
      INSERT INTO hero_slides (
        slide_order, slide_type, banner_image, banner_link, badge_text, title, subtitle,
        primary_btn_text, primary_btn_link, secondary_btn_text, secondary_btn_link, bg_gradient, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      3,
      'content',
      'wp-content/uploads/2026/08/Oxygen-Concentrator-Price-in-Bangladesh-1024x1024.png',
      '',
      '⚡ 5L & 10L Continuous Flow Models',
      'Oxygen Concentrator Rental & Sale at Best Price',
      '93%±3% high-purity medical oxygen 24/7 without cylinder refill hassle. Trusted Yuwell, Olive & DeVilbiss units with free doorstep installation.',
      'Rent Concentrator',
      'javascript:openRentalModal("Oxygen Concentrator")',
      'WhatsApp Inquiry',
      'https://wa.me/8801723002029?text=Hello%20ResAirBD,%20I%20want%20to%20rent/buy%20an%20Oxygen%20Concentrator',
      'linear-gradient(135deg, #0d9488 0%, #0f766e 100%)',
      1
    ]);

    // Slide 4: BiPAP / CPAP / Hospital Bed
    await run(`
      INSERT INTO hero_slides (
        slide_order, slide_type, banner_image, banner_link, badge_text, title, subtitle,
        primary_btn_text, primary_btn_link, secondary_btn_text, secondary_btn_link, bg_gradient, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      4,
      'content',
      'wp-content/uploads/2026/08/BiPAP-CPAP-Machine-Price-in-Bangladesh-1024x1024.png',
      '',
      '🏥 Complete Home ICU Setup',
      'BiPAP, CPAP Machines & Electric Hospital Beds',
      'Advanced sleep apnea therapy, ventilators, suction machines, and 2-crank / 3-crank hospital beds with side rails and air mattress.',
      'Rent Hospital Bed',
      'javascript:openRentalModal("Hospital Bed")',
      'Order on WhatsApp',
      'https://wa.me/8801723002029?text=Hello%20ResAirBD,%20I%20need%20BiPAP/CPAP%20or%20Hospital%20Bed%20Setup',
      'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
      1
    ]);
    console.log('Seeded 4 default hero slides.');
  }

  // 4. Seed Site Settings
  const defaultSettings = {
    site_name: 'ResAir BD',
    tagline: 'Breath easy, life better',
    hotline: '+8801723002029',
    secondary_phone: '01355899429',
    whatsapp: '8801723002029',
    email: 'info@resairbd.com',
    address: 'House 2, 100 Feet Road - Madani Avenue, Shaheenbag, Mohakhali, Dhaka 1212',
    logo_url: 'assets/logo-white-bg.png',
    delivery_inside_dhaka: '100',
    delivery_outside_dhaka: '150',
    free_delivery_threshold: '10000',
    powered_by_name: 'n8ntechbd.com',
    powered_by_url: 'https://n8ntechbd.com'
  };

  for (const [key, val] of Object.entries(defaultSettings)) {
    const existing = await get('SELECT value FROM site_settings WHERE key = ?', [key]);
    if (!existing) {
      await run('INSERT INTO site_settings (key, value) VALUES (?, ?)', [key, val]);
    }
  }
  console.log('Seeded default site settings.');

  console.log('--- Seeding Completed Successfully! ---');
}

if (require.main === module) {
  seed().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('Seeding error:', err);
    process.exit(1);
  });
}

module.exports = { seed };
