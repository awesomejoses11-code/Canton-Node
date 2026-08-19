/* =========================================================================
 * api/auth.js — register | login | me | google | config
 * ========================================================================= */
var crypto = require('crypto');
var db = require('../lib/db');

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}
function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sessionExpiryIso() {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

async function issueSession(sql, email, username) {
  var token = makeToken();
  var expiresAt = sessionExpiryIso();
  await sql`INSERT INTO sessions (token, email, expires_at) VALUES (${token}, ${email}, ${expiresAt})`;
  return {
    status: 200,
    json: {
      ok: true,
      user: { email: email, username: username },
      token: token,
      expiresAt: expiresAt
    }
  };
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
  var out = await issueSession(sql, email, username);
  out.status = 201;
  return out;
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
  if (!user.password_hash || !user.salt) {
    return {
      status: 401,
      json: { ok: false, error: 'This account uses Google sign-in. Use Continue with Google.' }
    };
  }
  if (hashPassword(password, user.salt) !== user.password_hash) {
    return { status: 401, json: { ok: false, error: 'Incorrect password.' } };
  }
  return issueSession(sql, user.email, user.username);
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

/** Verify Google ID token via tokeninfo (aud must match GOOGLE_CLIENT_ID). */
async function verifyGoogleIdToken(idToken) {
  var clientId = process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';
  if (!clientId) {
    return { ok: false, error: 'GOOGLE_CLIENT_ID is not configured on the server.' };
  }
  var url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken);
  var resp;
  try {
    resp = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(12000) });
  } catch (e) {
    return { ok: false, error: 'Could not reach Google token verification.' };
  }
  var profile = null;
  try { profile = await resp.json(); } catch (_) { profile = null; }
  if (!resp.ok || !profile) {
    return { ok: false, error: 'Invalid Google credential.' };
  }
  if (String(profile.aud || '') !== String(clientId)) {
    return { ok: false, error: 'Google token audience mismatch.' };
  }
  var verified = profile.email_verified === true || profile.email_verified === 'true';
  if (!verified) {
    return { ok: false, error: 'Google email is not verified.' };
  }
  var email = String(profile.email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') === -1) {
    return { ok: false, error: 'Google account has no email.' };
  }
  return {
    ok: true,
    email: email,
    sub: String(profile.sub || ''),
    name: String(profile.name || profile.given_name || email.split('@')[0]).trim().slice(0, 80)
  };
}

async function doGoogle(body) {
  var idToken = String(body.idToken || body.credential || '').trim();
  if (!idToken) {
    return { status: 400, json: { ok: false, error: 'Missing Google idToken.' } };
  }

  var verified = await verifyGoogleIdToken(idToken);
  if (!verified.ok) {
    return { status: 401, json: { ok: false, error: verified.error } };
  }

  await db.ensureSchema();
  var sql = db.getSql();
  var email = verified.email;
  var sub = verified.sub;
  var username = verified.name || email.split('@')[0];

  // Prefer match by google_sub, then by email
  var bySub = sub
    ? await sql`SELECT email, username, google_sub FROM users WHERE google_sub = ${sub} LIMIT 1`
    : [];
  var byEmail = await sql`SELECT email, username, google_sub FROM users WHERE email = ${email} LIMIT 1`;

  if (bySub && bySub.length) {
    return issueSession(sql, bySub[0].email, bySub[0].username);
  }

  if (byEmail && byEmail.length) {
    // Link Google to existing password account
    if (sub) {
      await sql`UPDATE users SET google_sub = ${sub} WHERE email = ${email}`;
    }
    return issueSession(sql, byEmail[0].email, byEmail[0].username);
  }

  // New Google-only user (no password)
  await sql`
    INSERT INTO users (email, username, password_hash, salt, google_sub)
    VALUES (${email}, ${username}, NULL, NULL, ${sub || null})
  `;
  var out = await issueSession(sql, email, username);
  out.status = 201;
  return out;
}

function doConfig() {
  var clientId = process.env.GOOGLE_CLIENT_ID || process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';
  return {
    status: 200,
    json: {
      ok: true,
      googleClientId: clientId || null,
      googleEnabled: !!clientId
    }
  };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'POST' && req.method !== 'GET') {
      res.status(405).json({ ok: false, error: 'Method not allowed' });
      return;
    }

    var body = {};
    if (req.method === 'POST') {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    }
    var action = String(body.action || (req.query && req.query.action) || '').toLowerCase();

    // Public config (no DB required) — client needs Google Client ID
    if (action === 'config' || (req.method === 'GET' && !action)) {
      var cfg = doConfig();
      res.status(cfg.status).json(cfg.json);
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

    if (!action) {
      if (body.idToken || body.credential) action = 'google';
      else if (body.username && body.password) action = 'register';
      else if (body.password && body.email) action = 'login';
      else action = 'me';
    }

    var out;
    if (action === 'register') out = await doRegister(body);
    else if (action === 'login') out = await doLogin(body);
    else if (action === 'me') out = await doMe(body, req);
    else if (action === 'google') out = await doGoogle(body);
    else if (action === 'config') out = doConfig();
    else {
      res.status(400).json({ ok: false, error: 'Unknown action. Use register | login | me | google | config' });
      return;
    }
    res.status(out.status).json(out.json);
  } catch (err) {
    console.error('[auth]', err);
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err).slice(0, 300) });
  }
};
