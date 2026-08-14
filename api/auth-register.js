/* =========================================================================
 * api/auth-register.js — POST { email, username, password }
 * ========================================================================= */

var crypto = require('crypto');
var db = require('./db');

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Method not allowed' });
      return;
    }

    if (!db.hasDatabase()) {
      res.status(503).json({
        ok: false,
        error: 'DATABASE_URL not configured. Connect Neon to this project and redeploy.',
        code: 'no_db'
      });
      return;
    }

    var body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    var email = String(body.email || '').trim().toLowerCase();
    var username = String(body.username || '').trim();
    var password = String(body.password || '');

    if (!email || email.indexOf('@') === -1) {
      res.status(400).json({ ok: false, error: 'Enter a valid email address.' });
      return;
    }
    if (!username) {
      res.status(400).json({ ok: false, error: 'Pick a user name.' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });
      return;
    }

    await db.ensureSchema();
    var sql = db.getSql();

    var existing = await sql`SELECT email FROM users WHERE email = ${email} LIMIT 1`;
    if (existing && existing.length) {
      res.status(409).json({ ok: false, error: 'An account with this email already exists. Sign in instead.' });
      return;
    }

    var salt = crypto.randomBytes(16).toString('hex');
    var passwordHash = hashPassword(password, salt);

    await sql`
      INSERT INTO users (email, username, password_hash, salt)
      VALUES (${email}, ${username}, ${passwordHash}, ${salt})
    `;

    var token = makeToken();
    var expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await sql`
      INSERT INTO sessions (token, email, expires_at)
      VALUES (${token}, ${email}, ${expiresAt})
    `;

    res.status(201).json({
      ok: true,
      user: { email: email, username: username },
      token: token,
      expiresAt: expiresAt
    });
  } catch (err) {
    console.error('[auth-register]', err);
    res.status(500).json({
      ok: false,
      error: String(err && err.message ? err.message : err).slice(0, 300)
    });
  }
};
