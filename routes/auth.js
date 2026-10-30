const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { get, run, all } = require('../db/database');

const COOKIE_NAME = 'rabd_token';
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const loginAttempts = new Map();

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be configured with at least 32 characters');
  }
  return secret;
}

function getLoginAttemptKey(req) {
  const username = typeof req.body?.username === 'string'
    ? req.body.username.trim().toLowerCase().slice(0, 100)
    : '';
  return `${req.ip || req.socket.remoteAddress || 'unknown'}:${username}`;
}

function limitLoginAttempts(req, res, next) {
  const key = getLoginAttemptKey(req);
  const now = Date.now();
  if (loginAttempts.size > 10000) {
    for (const [attemptKey, attempt] of loginAttempts) {
      if (now - attempt.startedAt >= LOGIN_WINDOW_MS) loginAttempts.delete(attemptKey);
    }
  }
  let state = loginAttempts.get(key);

  if (!state || now - state.startedAt >= LOGIN_WINDOW_MS) {
    state = { startedAt: now, count: 0 };
    loginAttempts.set(key, state);
  }

  if (state.count >= LOGIN_MAX_ATTEMPTS) {
    const retryAfter = Math.ceil((LOGIN_WINDOW_MS - (now - state.startedAt)) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }

  req.loginAttemptKey = key;
  next();
}

function recordFailedLogin(req) {
  const state = loginAttempts.get(req.loginAttemptKey);
  if (state) state.count += 1;
}

// Middleware to verify JWT from cookie or header
async function requireAuth(req, res, next) {
  let token;
  let decoded;
  try {
    const secret = getJwtSecret();
    token = (req.cookies && req.cookies[COOKIE_NAME]) ||
      (req.headers.authorization && req.headers.authorization.split(' ')[1]);
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    decoded = jwt.verify(token, secret);
  } catch (err) {
    if (err.message.includes('JWT_SECRET')) {
      return res.status(503).json({ error: 'Authentication is not configured on this server' });
    }
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  let user;
  try {
    user = await get(
      'SELECT id, username, email, role, is_active FROM users WHERE id = ?',
      [decoded.id]
    );
  } catch (err) {
    console.error('Authentication lookup failed:', err);
    return res.status(500).json({ error: 'Failed to verify the current user' });
  }

  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'User no longer exists or is inactive' });
  }

  req.user = user;
  next();
}

// Middleware for Role restriction
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied: insufficient permissions' });
    }
    next();
  };
}

router.get('/setup-status', async (req, res) => {
  try {
    const owner = await get("SELECT id FROM users WHERE role = 'owner' AND is_active = 1 LIMIT 1");
    res.json({ setupRequired: !owner });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check admin setup status' });
  }
});

// Helper to log audit actions
async function logAudit(user, action, details) {
  await run(
    'INSERT INTO audit_logs (user_id, username, action, details, created_at) VALUES (?, ?, ?, ?, ?)',
    [user ? user.id : null, user ? user.username : 'system', action, details, new Date().toISOString()]
  );
}

// Login
router.post('/login', limitLoginAttempts, async (req, res) => {
  const body = req.body || {};
  const { username, password } = body;
  if (typeof username !== 'string' || typeof password !== 'string' ||
      !username.trim() || !password || username.length > 100 || password.length > 256) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const secret = getJwtSecret();
    const user = await get('SELECT * FROM users WHERE username = ?', [username.trim()]);
    if (!user || !user.is_active) {
      recordFailedLogin(req);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      recordFailedLogin(req);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    loginAttempts.delete(req.loginAttemptKey);
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      secret,
      { expiresIn: '7d' }
    );

    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    await logAudit(user, 'USER_LOGIN', `User ${user.username} logged in successfully`);

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    if (err.message.includes('JWT_SECRET')) {
      return res.status(503).json({ error: 'Authentication is not configured on this server' });
    }
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout
router.post('/logout', requireAuth, async (req, res) => {
  await logAudit(req.user, 'USER_LOGOUT', `User ${req.user.username} logged out`);
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api'
  });
  res.json({ success: true, message: 'Logged out successfully' });
});

// Current User
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Change Password
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' ||
      newPassword.length < 12 || newPassword.length > 256) {
    return res.status(400).json({ error: 'New password must be at least 12 characters' });
  }

  try {
    const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
      newHash,
      new Date().toISOString(),
      user.id
    ]);

    await logAudit(req.user, 'PASSWORD_CHANGE', 'User updated their password');
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update password' });
  }
});

// User Management (Owner only)
router.get('/users', requireAuth, requireRole('owner'), async (req, res) => {
  try {
    const users = await all(
      'SELECT id, username, email, role, is_active, created_at, updated_at FROM users ORDER BY id ASC'
    );
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load users' });
  }
});

router.post('/users', requireAuth, requireRole('owner'), async (req, res) => {
  const { username, email, password, role } = req.body;
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'Username, password and role are required' });
  }

  if (!['owner', 'staff'].includes(role)) {
    return res.status(400).json({ error: 'Role must be either owner or staff' });
  }
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{3,32}$/.test(username.trim()) ||
      typeof password !== 'string' || password.length < 12 || password.length > 256) {
    return res.status(400).json({ error: 'Use a valid username and a password of at least 12 characters' });
  }
  if (email !== undefined && typeof email !== 'string') {
    return res.status(400).json({ error: 'Email must be a string' });
  }

  try {
    const existing = await get('SELECT id FROM users WHERE username = ?', [username.trim()]);
    if (existing) {
      return res.status(400).json({ error: 'Username already in use' });
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await run(
      'INSERT INTO users (username, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
      [username.trim(), (email || '').trim(), hash, role, new Date().toISOString()]
    );

    await logAudit(req.user, 'CREATE_USER', `Created user ${username} with role ${role}`);
    res.json({ success: true, userId: result.id, message: 'User created successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create user' });
  }
});

router.put('/users/:id', requireAuth, requireRole('owner'), async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const { role, password, email } = req.body;

  try {
    if (!Number.isSafeInteger(targetId) || targetId < 1) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    if (role !== undefined && !['owner', 'staff'].includes(role)) {
      return res.status(400).json({ error: 'Role must be either owner or staff' });
    }
    if (password !== undefined &&
        (typeof password !== 'string' || password.length < 12 || password.length > 256)) {
      return res.status(400).json({ error: 'Password must be at least 12 characters' });
    }
    if (email !== undefined && typeof email !== 'string') {
      return res.status(400).json({ error: 'Email must be a string' });
    }

    const targetUser = await get('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Protection: If changing role away from owner, ensure at least one other owner remains
    if (targetUser.role === 'owner' && role && role !== 'owner') {
      const ownerCount = (await get("SELECT COUNT(*) as count FROM users WHERE role = 'owner'")).count;
      if (ownerCount <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last owner account' });
      }
    }

    const updates = [];
    const params = [];

    if (role && ['owner', 'staff'].includes(role)) {
      updates.push('role = ?');
      params.push(role);
    }
    if (email !== undefined) {
      updates.push('email = ?');
      params.push(email.trim());
    }
    if (password && password.trim().length >= 6) {
      const hash = await bcrypt.hash(password.trim(), 12);
      updates.push('password_hash = ?');
      params.push(hash);
    }

    updates.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(targetId);

    await run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
    await logAudit(req.user, 'UPDATE_USER', `Updated user ID ${targetId}`);

    res.json({ success: true, message: 'User updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

router.delete('/users/:id', requireAuth, requireRole('owner'), async (req, res) => {
  const targetId = parseInt(req.params.id, 10);

  try {
    if (!Number.isSafeInteger(targetId) || targetId < 1) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const targetUser = await get('SELECT * FROM users WHERE id = ?', [targetId]);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (targetUser.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own logged-in account' });
    }

    if (targetUser.role === 'owner') {
      const ownerCount = (await get("SELECT COUNT(*) as count FROM users WHERE role = 'owner'")).count;
      if (ownerCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the only remaining owner account' });
      }
    }

    await run('DELETE FROM users WHERE id = ?', [targetId]);
    await logAudit(req.user, 'DELETE_USER', `Deleted user ${targetUser.username} (ID: ${targetId})`);

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = {
  router,
  requireAuth,
  requireRole,
  logAudit,
  getJwtSecret
};
