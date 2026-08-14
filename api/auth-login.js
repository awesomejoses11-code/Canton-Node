/* =========================================================================
 * api/auth-login.js — POST { email, password }
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
    var password = String(body.password || '');

    if (!email || !password) {
      res.status(400).json({ ok: false, error: 'Email and password required.' });
      return;
    }

    await db.ensureSchema();
    var sql = db.getSql();

    var rows = await sql`
      SELECT email, username, password_hash, salt
      FROM users WHERE email = ${email} LIMIT 1
    `;
    if (!rows || !rows.length) {
      res.status(401).json({ ok: false, error: 'No account found for this email. Register first.' });
      return;
    }

    var user = rows[0];
    var hash = hashPassword(password, user.salt);
    if (hash !== user.password_hash) {
      res.status(401).json({ ok: false, error: 'Incorrect password.' });
      return;
    }

    var token = makeToken();
    var expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await sql`
      INSERT INTO sessions (token, email, expires_at)
      VALUES (${token}, ${user.email}, ${expiresAt})
    `;

    res.status(200).json({
      ok: true,
      user: { email: user.email, username: user.username },
      token: token,
      expiresAt: expiresAt
    });
  } catch (err) {
    console.error('[auth-login]', err);
    res.status(500).json({
      ok: false,
      error: String(err && err.message ? err.message : err).slice(0, 300)
    });
  }
};
