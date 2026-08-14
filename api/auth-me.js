/* =========================================================================
 * api/auth-me.js — POST { token } → current user or 401
 * ========================================================================= */

var db = require('./db');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    if (req.method !== 'POST' && req.method !== 'GET') {
      res.status(405).json({ ok: false, error: 'Method not allowed' });
      return;
    }

    if (!db.hasDatabase()) {
      res.status(503).json({ ok: false, error: 'DATABASE_URL not configured', code: 'no_db' });
      return;
    }

    var body = {};
    if (req.method === 'POST') {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    }
    var token =
      body.token ||
      (req.headers.authorization && String(req.headers.authorization).replace(/^Bearer\s+/i, '')) ||
      '';
    token = String(token || '').trim();
    if (!token) {
      res.status(401).json({ ok: false, error: 'Missing session token.' });
      return;
    }

    await db.ensureSchema();
    var sql = db.getSql();

    var rows = await sql`
      SELECT s.token, s.email, s.expires_at, u.username
      FROM sessions s
      JOIN users u ON u.email = s.email
      WHERE s.token = ${token}
      LIMIT 1
    `;

    if (!rows || !rows.length) {
      res.status(401).json({ ok: false, error: 'Invalid session.' });
      return;
    }

    var row = rows[0];
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await sql`DELETE FROM sessions WHERE token = ${token}`;
      res.status(401).json({ ok: false, error: 'Session expired.' });
      return;
    }

    res.status(200).json({
      ok: true,
      user: { email: row.email, username: row.username },
      expiresAt: row.expires_at
    });
  } catch (err) {
    console.error('[auth-me]', err);
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err).slice(0, 300) });
  }
};
