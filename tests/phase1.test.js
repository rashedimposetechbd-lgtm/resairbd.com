const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'resairbd-phase1-'));
process.env.RESAIRBD_DB_PATH = path.join(tempDirectory, 'test.db');
process.env.JWT_SECRET = crypto.randomBytes(48).toString('base64url');
process.env.ADMIN_USERNAME = 'owner_test';
process.env.ADMIN_PASSWORD = 'A-unique-test-password-2026';
process.env.NODE_ENV = 'test';

const app = require('../server');
const { initDB, get, run, db } = require('../db/database');
const { seed } = require('../db/seed');
const { bootstrapAdmin } = require('../scripts/bootstrap-admin');

test('Phase 1 admin, authorization, and static-file boundaries', async () => {
  let server;

  try {
    await initDB();
    await seed();
    await bootstrapAdmin();

    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const home = await fetch(`${baseUrl}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);

    const adminPage = await fetch(`${baseUrl}/admin`);
    assert.equal(adminPage.status, 200);
    assert.match(adminPage.headers.get('content-security-policy'), /script-src 'self'/);

    for (const privatePath of ['/server.js', '/data/resairbd.db']) {
      const response = await fetch(`${baseUrl}${privatePath}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);
      assert.doesNotMatch(await response.text(), /SQLite format 3|const express = require/);
    }

    const missingApi = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(missingApi.status, 404);
    assert.deepEqual(await missingApi.json(), { error: 'API route not found' });

    const productResponse = await fetch(`${baseUrl}/api/products?all=true`);
    const productData = await productResponse.json();
    assert.equal(productResponse.status, 200);
    assert.equal(productData.products.length, 222);

    const setupStatus = await fetch(`${baseUrl}/api/auth/setup-status`);
    assert.deepEqual(await setupStatus.json(), { setupRequired: false });

    const unauthenticatedAudit = await fetch(`${baseUrl}/api/audit-logs`);
    assert.equal(unauthenticatedAudit.status, 401);

    const ownerLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: process.env.ADMIN_USERNAME,
        password: process.env.ADMIN_PASSWORD
      })
    });
    assert.equal(ownerLogin.status, 200);
    const ownerCookie = ownerLogin.headers.get('set-cookie').split(';')[0];
    assert.match(ownerLogin.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(ownerLogin.headers.get('set-cookie'), /SameSite=Strict/i);

    const unsafeImage = new FormData();
    unsafeImage.append(
      'image',
      new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], { type: 'image/svg+xml' }),
      'unsafe.svg'
    );
    const rejectedUpload = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: { Cookie: ownerCookie },
      body: unsafeImage
    });
    assert.equal(rejectedUpload.status, 400);

    const staffCreate = await fetch(`${baseUrl}/api/auth/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
      body: JSON.stringify({
        username: 'staff_test',
        password: 'A-different-test-password-2026',
        role: 'staff'
      })
    });
    assert.equal(staffCreate.status, 200);

    const staffLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'staff_test',
        password: 'A-different-test-password-2026'
      })
    });
    assert.equal(staffLogin.status, 200);
    const staffCookie = staffLogin.headers.get('set-cookie').split(';')[0];

    const staffSettings = await fetch(`${baseUrl}/api/settings`, {
      headers: { Cookie: staffCookie }
    });
    assert.equal(staffSettings.status, 403);

    const staffAudit = await fetch(`${baseUrl}/api/audit-logs`, {
      headers: { Cookie: staffCookie }
    });
    assert.equal(staffAudit.status, 403);

    const staffWrite = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ name: 'Blocked test item', category: 'Test', price: 1 })
    });
    assert.equal(staffWrite.status, 403);

    const staffManage = await fetch(`${baseUrl}/api/products/manage`, {
      headers: { Cookie: staffCookie }
    });
    assert.equal(staffManage.status, 200);
    assert.equal((await staffManage.json()).total, 222);
    const unauthenticatedManage = await fetch(`${baseUrl}/api/products/manage`);
    assert.equal(unauthenticatedManage.status, 401);

    const ownerDashboard = await fetch(`${baseUrl}/api/analytics/overview`, {
      headers: { Cookie: ownerCookie }
    });
    assert.equal(ownerDashboard.status, 200);
    assert.equal((await ownerDashboard.json()).products.total, 222);

    const ownerAudit = await fetch(`${baseUrl}/api/audit-logs`, {
      headers: { Cookie: ownerCookie }
    });
    assert.equal(ownerAudit.status, 200);

    const ownerHeaders = { 'Content-Type': 'application/json', Cookie: ownerCookie };
    const createCategory = await fetch(`${baseUrl}/api/categories`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ name: 'Phase 2 Test', image: 'assets/test.png', desc: 'Catalog test' })
    });
    assert.equal(createCategory.status, 201);
    const categoryId = (await createCategory.json()).id;

    const invalidProduct = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        name: 'Invalid catalog item',
        category: 'Phase 2 Test',
        price: 20,
        originalPrice: 10,
        image: 'javascript:alert(1)'
      })
    });
    assert.equal(invalidProduct.status, 400);

    const createProduct = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        name: 'Phase 2 Catalog Item',
        category: 'Phase 2 Test',
        price: 20,
        originalPrice: 25,
        image: 'assets/test.png',
        inStock: true,
        specs: ['Test specification']
      })
    });
    assert.equal(createProduct.status, 201);
    const createdProduct = await createProduct.json();

    const activeManage = await fetch(`${baseUrl}/api/products/manage?status=active&q=Phase%202%20Catalog`, {
      headers: { Cookie: ownerCookie }
    });
    assert.equal(activeManage.status, 200);
    assert.equal((await activeManage.json()).total, 1);
    const invalidPage = await fetch(`${baseUrl}/api/products/manage?page=1.5`, {
      headers: { Cookie: ownerCookie }
    });
    assert.equal(invalidPage.status, 400);

    const updateProduct = await fetch(`${baseUrl}/api/products/${createdProduct.id}`, {
      method: 'PUT',
      headers: ownerHeaders,
      body: JSON.stringify({ price: 22, originalPrice: 25, description: 'Updated description' })
    });
    assert.equal(updateProduct.status, 200);
    const invalidUpdate = await fetch(`${baseUrl}/api/products/${createdProduct.id}`, {
      method: 'PUT',
      headers: ownerHeaders,
      body: JSON.stringify({ price: 26, originalPrice: 25 })
    });
    assert.equal(invalidUpdate.status, 400);

    const renameCategory = await fetch(`${baseUrl}/api/categories/${categoryId}`, {
      method: 'PUT',
      headers: ownerHeaders,
      body: JSON.stringify({ name: 'Renamed Phase 2 Test' })
    });
    assert.equal(renameCategory.status, 200);
    const renamedProduct = await fetch(`${baseUrl}/api/products/${createdProduct.id}`);
    assert.equal((await renamedProduct.json()).product.category, 'Renamed Phase 2 Test');

    const archiveProduct = await fetch(`${baseUrl}/api/products/${createdProduct.id}/archive`, {
      method: 'PATCH',
      headers: { Cookie: ownerCookie }
    });
    assert.equal(archiveProduct.status, 200);
    const hiddenProduct = await fetch(`${baseUrl}/api/products/${createdProduct.id}`);
    assert.equal(hiddenProduct.status, 404);
    const archivedManage = await fetch(`${baseUrl}/api/products/manage?status=archived&q=Phase%202%20Catalog`, {
      headers: { Cookie: ownerCookie }
    });
    assert.equal((await archivedManage.json()).total, 1);

    const protectedCategoryDelete = await fetch(`${baseUrl}/api/categories/${categoryId}`, {
      method: 'DELETE',
      headers: { Cookie: ownerCookie }
    });
    assert.equal(protectedCategoryDelete.status, 409);

    const restoreProduct = await fetch(`${baseUrl}/api/products/${createdProduct.id}/restore`, {
      method: 'PATCH',
      headers: { Cookie: ownerCookie }
    });
    assert.equal(restoreProduct.status, 200);
    const publicProducts = await fetch(`${baseUrl}/api/products?all=true`);
    const publicProductData = await publicProducts.json();
    assert.equal(publicProductData.products.length, 223);
    assert.ok(publicProductData.products.some(product => product.uid === createdProduct.uid));
    const publicCategories = await fetch(`${baseUrl}/api/categories`);
    assert.ok((await publicCategories.json()).categories.some(
      category => category.name === 'Renamed Phase 2 Test' && category.count === 1
    ));
    await run('UPDATE products SET is_active = 0');
    const emptyCatalog = await fetch(`${baseUrl}/api/products?all=true`);
    assert.deepEqual((await emptyCatalog.json()).products, []);
    await run('UPDATE products SET is_active = 1');

    const catalogProduct = await get(
      'SELECT id, uid, name, price FROM products WHERE is_active = 1 AND in_stock = 1 LIMIT 1'
    );
    const submittedOrder = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: 'CLIENT-CONTROLLED-ID',
        customer: {
          name: 'Order Test Customer',
          phone: '01712345678',
          area: 'dhaka',
          address: 'Dhaka test address'
        },
        paymentMethod: 'COD',
        subtotal: 0,
        deliveryFee: 0,
        grandTotal: 0,
        items: [{ uid: catalogProduct.uid, qty: 2, price: 0, name: 'Tampered name' }]
      })
    });
    assert.equal(submittedOrder.status, 201);
    const orderResult = await submittedOrder.json();
    assert.notEqual(orderResult.orderId, 'CLIENT-CONTROLLED-ID');
    assert.equal(orderResult.subtotal, Number(catalogProduct.price) * 2);
    assert.equal(orderResult.grandTotal, Number(catalogProduct.price) * 2 +
      (Number(catalogProduct.price) * 2 >= 10000 ? 0 : 100));
    assert.equal(orderResult.items[0].name, catalogProduct.name);
    assert.equal(orderResult.items[0].price, Number(catalogProduct.price));

    const invalidOrder = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: { name: 'Bad', phone: 'not-a-phone', area: 'dhaka', address: 'Here' },
        paymentMethod: 'COD',
        items: [{ uid: catalogProduct.uid, qty: 1 }]
      })
    });
    assert.equal(invalidOrder.status, 400);
    const unavailableOrder = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: { name: 'Bad', phone: '01712345678', area: 'dhaka', address: 'Here' },
        paymentMethod: 'COD',
        items: [{ uid: 'p_999999', qty: 1 }]
      })
    });
    assert.equal(unavailableOrder.status, 400);

    const unauthenticatedOrders = await fetch(`${baseUrl}/api/orders`);
    assert.equal(unauthenticatedOrders.status, 401);
    const ownerOrders = await fetch(`${baseUrl}/api/orders?q=Order%20Test`, {
      headers: { Cookie: ownerCookie }
    });
    assert.equal(ownerOrders.status, 200);
    const orderList = await ownerOrders.json();
    assert.equal(orderList.total, 1);
    assert.equal(orderList.orders[0].orderId, orderResult.orderId);
    const invalidOrderPage = await fetch(`${baseUrl}/api/orders?page=1.5`, {
      headers: { Cookie: ownerCookie }
    });
    assert.equal(invalidOrderPage.status, 400);
    const orderStatus = await fetch(`${baseUrl}/api/orders/${orderResult.orderId}/status`, {
      method: 'PATCH',
      headers: ownerHeaders,
      body: JSON.stringify({ status: 'confirmed' })
    });
    assert.equal(orderStatus.status, 200);
    const invalidOrderStatus = await fetch(`${baseUrl}/api/orders/${orderResult.orderId}/status`, {
      method: 'PATCH',
      headers: ownerHeaders,
      body: JSON.stringify({ status: 'refunded' })
    });
    assert.equal(invalidOrderStatus.status, 400);

    const invalidBooking = await fetch(`${baseUrl}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'Rental', name: 'Test', phone: '123', address: 'Here' })
    });
    assert.equal(invalidBooking.status, 400);
    const submittedBooking = await fetch(`${baseUrl}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'Oxygen cylinder setup',
        name: 'Booking Test Customer',
        phone: '01812345678',
        address: 'Uttara, Dhaka',
        notes: 'Urgent delivery'
      })
    });
    assert.equal(submittedBooking.status, 201);
    const bookingResult = await submittedBooking.json();
    const ownerBookings = await fetch(`${baseUrl}/api/bookings?q=Booking%20Test`, {
      headers: { Cookie: staffCookie }
    });
    assert.equal(ownerBookings.status, 200);
    const bookingList = await ownerBookings.json();
    assert.equal(bookingList.total, 1);
    assert.equal(bookingList.bookings[0].bookingId, bookingResult.bookingId);
    const bookingStatus = await fetch(`${baseUrl}/api/bookings/${bookingResult.bookingId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie },
      body: JSON.stringify({ status: 'contacted' })
    });
    assert.equal(bookingStatus.status, 200);
    const invalidBookingStatus = await fetch(`${baseUrl}/api/bookings/${bookingResult.bookingId}/status`, {
      method: 'PATCH',
      headers: ownerHeaders,
      body: JSON.stringify({ status: 'paid' })
    });
    assert.equal(invalidBookingStatus.status, 400);

    const publicConfig = await fetch(`${baseUrl}/api/site-config`);
    assert.equal(publicConfig.status, 200);
    const publicSettings = (await publicConfig.json()).settings;
    assert.equal(publicSettings.delivery_inside_dhaka, '100');
    assert.equal(Object.hasOwn(publicSettings, 'secret'), false);

    const unsupportedSetting = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: ownerHeaders,
      body: JSON.stringify({ settings: { arbitrary_internal_key: 'value' } })
    });
    assert.equal(unsupportedSetting.status, 400);
    const invalidPhoneSetting = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: ownerHeaders,
      body: JSON.stringify({ settings: { hotline: '++++++++' } })
    });
    assert.equal(invalidPhoneSetting.status, 400);
    const updateSiteSettings = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: ownerHeaders,
      body: JSON.stringify({
        settings: {
          delivery_inside_dhaka: '125',
          delivery_outside_dhaka: '225',
          free_delivery_threshold: '15000',
          hotline: '+8801711111111'
        }
      })
    });
    assert.equal(updateSiteSettings.status, 200);
    const updatedPublicConfig = await fetch(`${baseUrl}/api/site-config`);
    assert.equal((await updatedPublicConfig.json()).settings.hotline, '+8801711111111');

    const adjustedPriceOrder = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer: {
          name: 'Updated Delivery Price Customer',
          phone: '01712345678',
          area: 'dhaka',
          address: 'Dhaka test address'
        },
        paymentMethod: 'COD',
        items: [{ uid: catalogProduct.uid, qty: 1 }]
      })
    });
    assert.equal(adjustedPriceOrder.status, 201);
    assert.equal((await adjustedPriceOrder.json()).deliveryFee, 125);

    const unsafeSlide = await fetch(`${baseUrl}/api/sliders`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        slideType: 'content',
        primaryBtnLink: 'javascript:alert(1)'
      })
    });
    assert.equal(unsafeSlide.status, 400);
    const createSlide = await fetch(`${baseUrl}/api/sliders`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        slideType: 'content',
        title: 'Phase 4 Test Slide',
        subtitle: 'A controlled slide for integration tests',
        primaryBtnText: 'Call now',
        primaryBtnLink: 'tel:+8801711111111',
        bgGradient: 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)'
      })
    });
    assert.equal(createSlide.status, 201);
    const createdSlide = await createSlide.json();
    const publicSlides = await fetch(`${baseUrl}/api/sliders`);
    assert.ok((await publicSlides.json()).slides.some(slide => slide.id === createdSlide.id));
    const disableSlide = await fetch(`${baseUrl}/api/sliders/${createdSlide.id}`, {
      method: 'PUT',
      headers: ownerHeaders,
      body: JSON.stringify({ isActive: false })
    });
    assert.equal(disableSlide.status, 200);
    const publicSlidesAfterDisable = await fetch(`${baseUrl}/api/sliders`);
    assert.equal((await publicSlidesAfterDisable.json()).slides.some(slide => slide.id === createdSlide.id), false);
    const ownerSlides = await fetch(`${baseUrl}/api/sliders?all=true`, {
      headers: { Cookie: ownerCookie }
    });
    assert.equal(ownerSlides.status, 200);
    assert.equal((await ownerSlides.json()).slides.some(
      slide => slide.id === createdSlide.id && !slide.isActive
    ), true);
    const deleteSlide = await fetch(`${baseUrl}/api/sliders/${createdSlide.id}`, {
      method: 'DELETE',
      headers: { Cookie: ownerCookie }
    });
    assert.equal(deleteSlide.status, 200);
    const staffSlides = await fetch(`${baseUrl}/api/sliders?all=true`, {
      headers: { Cookie: staffCookie }
    });
    assert.equal(staffSlides.status, 403);

    const trackedEvent = await fetch(`${baseUrl}/api/analytics/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'pageview',
        targetId: '',
        path: '/products',
        referrer: 'https://example.test/'
      })
    });
    assert.deepEqual(await trackedEvent.json(), { success: true, tracked: true });
    const unsupportedEvent = await fetch(`${baseUrl}/api/analytics/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'arbitrary_sql' })
    });
    assert.equal(unsupportedEvent.status, 400);
    const optedOutEvent = await fetch(`${baseUrl}/api/analytics/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', DNT: '1' },
      body: JSON.stringify({ eventType: 'pageview' })
    });
    assert.deepEqual(await optedOutEvent.json(), { success: true, tracked: false });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const rejectedSubmission = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.equal(rejectedSubmission.status, 400);
    }
    const rateLimitedSubmission = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(rateLimitedSubmission.status, 429);
    assert.ok(Number(rateLimitedSubmission.headers.get('retry-after')) > 0);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const failedLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'rate_limit_test', password: 'incorrect' })
      });
      assert.equal(failedLogin.status, 401);
    }
    const blockedLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'rate_limit_test', password: 'incorrect' })
    });
    assert.equal(blockedLogin.status, 429);

    const legacyHash = require('bcryptjs').hashSync('not-a-real-credential', 4);
    await run(
      'INSERT INTO users (username, password_hash, role, is_active, created_at) VALUES (?, ?, ?, 1, ?)',
      ['admin', legacyHash, 'owner', new Date().toISOString()]
    );
    await run('DELETE FROM schema_migrations WHERE name = ?', ['disable-seeded-default-accounts']);
    await initDB();
    const legacyAccount = await get('SELECT is_active FROM users WHERE username = ?', ['admin']);
    assert.equal(legacyAccount.is_active, 0);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await new Promise((resolve, reject) => {
      db.close(error => error ? reject(error) : resolve());
    });
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});
