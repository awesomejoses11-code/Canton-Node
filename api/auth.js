/* =========================================================================
 * api/auth.js — unified auth (Hobby plan: one function)
 * POST { action: "register"|"login"|"me", email?, username?, password?, token? }
 * ========================================================================= */
var crypto = require('crypto');
var db = require('../lib/db');

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}
function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function doRegister(body) {
  var email = String(body.email || '').trim().toLowerCase();
  var username = String(body.username || '').trim();
  var password = String(body.password || '');
  if (!email || email.indexOf('@') === -1) return { status: 400, json: { ok: false, error: 'Enter a valid email address.' } };
  if (!username) return { status: 400, json: { ok: false, error: 'Pick a user name.' } };
  if (password.length < 6) return { status: 400, json: { ok: false, error: 'Password must be at least 6 characters.' } };

  await db.ensureSchema();
  var sql = db.getSql();
  var existing = await sql`SELECT email FROM users WHERE email = ${email} LIMIT 1`;
  if (existing && existing.length) {
    return { status: 409, json: { ok: false, error: 'An account with this email already exists. Sign in instead.' } };
  }
  var salt = crypto.randomBytes(16).toString('hex');
  var passwordHash = hashPassword(password, salt);
  await sql`INSERT INTO users (email, username, password_hash, salt) VALUES (${email}, ${username}, ${passwordHash}, ${salt})`;
  var token = makeToken();
  var expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await sql`INSERT INTO sessions (token, email, expires_at) VALUES (${token}, ${email}, ${expiresAt})`;
  return { status: 201, json: { ok: true, user: { email: email, username: username }, token: token, expiresAt: expiresAt } };
}

async function doLogin(body) {
  var email = String(body.email || '').trim().toLowerCase();
  var password = String(body.password || '');
  if (!email || !password) return { status: 400, json: { ok: false, error: 'Email and password required.' } };
  await db.ensureSchema();
  var sql = db.getSql();
  var rows = await sql`SELECT email, username, password_hash, salt FROM users WHERE email = ${email} LIMIT 1`;
  if (!rows || !rows.length) return { status: 401, json: { ok: false, error: 'No account found for this email. Register first.' } };
  var user = rows[0];
  if (hashPassword(password, user.salt) !== user.password_hash) {
    return { status: 401, json: { ok: false, error: 'Incorrect password.' } };
  }
  var token = makeToken();
  var expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await sql`INSERT INTO sessions (token, email, expires_at) VALUES (${token}, ${user.email}, ${expiresAt})`;
  return { status: 200, json: { ok: true, user: { email: user.email, username: user.username }, token: token, expiresAt: expiresAt } };
}

async function doMe(body, req) {
  var token =
    (body && body.token) ||
    (req.headers.authorization && String(req.headers.authorization).replace(/^Bearer\s+/i, '')) ||
    '';
  token = String(token || '').trim();
  if (!token) return { status: 401, json: { ok: false, error: 'Missing session token.' } };
  await db.ensureSchema();
  var sql = db.getSql();
  var rows = await sql`
    SELECT s.token, s.email, s.expires_at, u.username
    FROM sessions s JOIN users u ON u.email = s.email
    WHERE s.token = ${token} LIMIT 1
  `;
  if (!rows || !rows.length) return { status: 401, json: { ok: false, error: 'Invalid session.' } };
  var row = rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await sql`DELETE FROM sessions WHERE token = ${token}`;
    return { status: 401, json: { ok: false, error: 'Session expired.' } };
  }
  return { status: 200, json: { ok: true, user: { email: row.email, username: row.username }, expiresAt: row.expires_at } };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'POST' && req.method !== 'GET') {
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
    var body = {};
    if (req.method === 'POST') {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    }
    var action = String(body.action || (req.query && req.query.action) || '').toLowerCase();
    if (!action) {
      if (body.username && body.password) action = 'register';
      else if (body.password && body.email) action = 'login';
      else action = 'me';
    }

    var out;
    if (action === 'register') out = await doRegister(body);
    else if (action === 'login') out = await doLogin(body);
    else if (action === 'me') out = await doMe(body, req);
    else {
      res.status(400).json({ ok: false, error: 'Unknown action. Use register | login | me' });
      return;
    }
    res.status(out.status).json(out.json);
  } catch (err) {
    console.error('[auth]', err);
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err).slice(0, 300) });
  }
};
