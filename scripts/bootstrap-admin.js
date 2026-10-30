const bcrypt = require('bcryptjs');
const { db, get, run, initDB } = require('../db/database');

async function bootstrapAdmin() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;

  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw new Error('ADMIN_USERNAME must be 3-32 letters, numbers, dots, underscores, or hyphens');
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw new Error('Set ADMIN_PASSWORD to a password between 12 and 256 characters');
  }

  await initDB();

  const existing = await get('SELECT id, role FROM users WHERE username = ?', [username]);
  const activeOwner = await get(
    "SELECT id FROM users WHERE role = 'owner' AND is_active = 1 LIMIT 1"
  );
  const passwordHash = await bcrypt.hash(password, 12);
  const now = new Date().toISOString();

  if (existing) {
    if (existing.role !== 'owner') {
      throw new Error('The selected username belongs to a non-owner account');
    }

    await run(
      'UPDATE users SET password_hash = ?, is_active = 1, updated_at = ? WHERE id = ?',
      [passwordHash, now, existing.id]
    );
    console.log(`Owner account "${username}" has been reset and enabled.`);
    return;
  }

  if (activeOwner) {
    throw new Error('An active owner already exists; choose an existing owner account to reset');
  }

  const email = process.env.ADMIN_EMAIL || null;
  await run(
    'INSERT INTO users (username, email, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    [username, email, passwordHash, 'owner', now]
  );
  console.log(`Owner account "${username}" has been created.`);
}

if (require.main === module) {
  bootstrapAdmin()
    .catch(err => {
      console.error(`Admin bootstrap failed: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => {
      db.close(err => {
        if (err) {
          console.error('Failed to close the database connection.');
          process.exitCode = 1;
        }
      });
    });
}

module.exports = { bootstrapAdmin };
