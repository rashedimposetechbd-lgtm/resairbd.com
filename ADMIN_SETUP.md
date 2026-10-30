# ResAirBD Admin setup

The admin app uses the existing Express server and SQLite database. It is served at `/admin`; public storefront markup and styles are not part of the admin bundle.

## Configure a signing secret

Set `JWT_SECRET` to a cryptographically random value of at least 32 characters. Keep it in the server's environment, not in source control. `.env.example` documents the required variable names and contains no credentials.

PowerShell example for generating a value locally:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
$env:JWT_SECRET = '<paste the generated value here>'
```

Do not paste the generated value into a chat, source file, or committed `.env` file.

## Back up and prepare the owner account

Back up `data/resairbd.db` before the first startup or schema migration. On its first initialization, the additive database migration disables legacy `admin` and `staff` accounts created with known defaults; it does not delete users or business data.

Reset the existing `admin` owner or create a new owner with a strong password before opening the admin panel:

```powershell
$env:ADMIN_USERNAME = 'admin'
$env:ADMIN_PASSWORD = '<choose a unique password of at least 12 characters>'
npm run bootstrap-admin
Remove-Item Env:ADMIN_PASSWORD
```

The bootstrap command initializes the schema, re-enables or creates the selected owner, and does not print the password. If an active owner already exists, the command only permits resetting that existing owner account.

For a new database, run the bootstrap command once to create an owner. The first server startup imports the current embedded product and category data if those tables are empty.

## Run

```powershell
npm start
```

Open `http://localhost:4173/admin`. Configure HTTPS and `NODE_ENV=production` in deployment so the session cookie is marked `Secure`.

## Implemented scope

- The authenticated admin has a dashboard, owner-only activity log, password change, and owner/staff API authorization.
- Owners can search, filter, sort, add, edit, archive, and restore products; product images can be uploaded and optimized. Staff can view the catalog but cannot modify it.
- Owners can create, rename, and delete categories. Renaming updates assigned products; deletion is blocked while any product (including an archived one) still uses the category.
- The public storefront loads the active catalog and categories from SQLite, while retaining the embedded catalog as a fallback if the API is unavailable or invalid. An intentionally empty server catalog is respected.
- Checkout orders and rental/service requests are validated and saved centrally. Product prices and delivery totals are calculated from the server catalog; customer confirmation is shown only after a successful save.
- Owners and staff can search, filter, page through, inspect, and update order and service-request statuses in the admin panel.
- Owners can create, edit, order, activate, deactivate, and delete storefront hero slides. Slide text, links, gradients, and local image paths are validated; active slides render from the API on the public homepage.
- Owners can update business contact details, public branding, delivery pricing, and upload an optimized logo with generated favicons. Public storefront pages use the configured contact details, delivery fees, logo, and branding.
- Public analytics events use an event allow-list, validated fields, Do Not Track support, and per-process request throttling.
- Login throttling, secure session cookies, static-file restrictions, upload validation, and security headers protect the admin endpoints.

## Remaining limitations

- Admin configuration does not yet include every possible SEO, payment-provider, or fulfillment integration.
- Browser-local order history and WhatsApp handoff remain available after the central order save succeeds. Rental requests are saved centrally before the WhatsApp follow-up opens.
- Public order, booking, analytics, and login throttles are in process memory; multi-instance deployments need a shared rate-limit store.
- Configure HTTPS and a shared rate-limit store before operating multiple production server instances.
- Existing dashboard counters reflect the local SQLite database. Traffic/revenue reporting is not represented as complete analytics.
- Login throttling is in-memory and resets when the process restarts; production deployments should add a shared rate-limit store if multiple server instances are used.
- SQLite backups must be taken before schema changes. Migrations add user/product activation flags; rollback should restore the pre-migration database backup.
- The production domain was in maintenance mode during discovery, so this phase was verified against the local project only.
