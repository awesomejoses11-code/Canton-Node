/* =========================================================================
 * api/docs.js — Per-user markdown memory docs on Neon
 * ========================================================================= */

var db = require('../lib/db');

var ALLOWED_KEYS = { reference: true, user_logs: true };

var DEFAULTS = {
  reference:
    '# Agent reference\n\n' +
    'Facts and context Master Agent should remember across sessions.\n\n' +
    '## Project\n\n' +
    '- App: Canton Node\n' +
    '- Role: multi-tool Master Agent (chat, image, video, music, TTS, MCP)\n\n' +
    '## Notes\n\n' +
    '(Add lasting facts here.)\n',
  user_logs:
    '# User log\n\n' +
    'Preferences and custom instructions for Master Agent.\n\n' +
    '## Preferences\n\n' +
    '- Tone: (set in Settings or override here)\n' +
    '- Topics of interest:\n\n' +
    '## Custom commands\n\n' +
    '- When I say "brief me", summarize in 5 bullets.\n\n' +
    '## Notes\n\n' +
    '(Master may append light notes when memory is enabled.)\n'
};

async function resolveEmail(token) {
  if (!token) return null;
  var sql = db.getSql();
  if (!sql) return null;
  var rows = await sql`
    SELECT s.email, s.expires_at FROM sessions s WHERE s.token = ${token} LIMIT 1
  `;
  if (!rows || !rows.length) return null;
  if (new Date(rows[0].expires_at).getTime() < Date.now()) {
    await sql`DELETE FROM sessions WHERE token = ${token}`;
    return null;
  }
  return rows[0].email;
}

function extractToken(req, body) {
  var t =
    (body && body.token) ||
    (req.query && req.query.token) ||
    (req.headers.authorization && String(req.headers.authorization).replace(/^Bearer\s+/i, '')) ||
    '';
  return String(t || '').trim();
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (!db.hasDatabase()) {
      res.status(503).json({ ok: false, error: 'DATABASE_URL not configured. Connect Neon and redeploy.', code: 'no_db' });
      return;
    }
    await db.ensureSchema();
    var sql = db.getSql();
    var body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    }
    var token = extractToken(req, body);
    var email = await resolveEmail(token);
    if (!email) {
      res.status(401).json({ ok: false, error: 'Invalid or missing session token.' });
      return;
    }

    if (req.method === 'GET' && (req.query && req.query.action === 'list')) {
      var all = await sql`SELECT doc_key, content, updated_at FROM user_docs WHERE email = ${email}`;
      var map = { reference: DEFAULTS.reference, user_logs: DEFAULTS.user_logs };
      var updated = {};
      (all || []).forEach(function (row) { map[row.doc_key] = row.content; updated[row.doc_key] = row.updated_at; });
      res.status(200).json({ ok: true, docs: map, updated_at: updated });
      return;
    }
    if (req.method === 'POST' && body.action === 'list') {
      var all2 = await sql`SELECT doc_key, content, updated_at FROM user_docs WHERE email = ${email}`;
      var map2 = { reference: DEFAULTS.reference, user_logs: DEFAULTS.user_logs };
      var updated2 = {};
      (all2 || []).forEach(function (row) { map2[row.doc_key] = row.content; updated2[row.doc_key] = row.updated_at; });
      res.status(200).json({ ok: true, docs: map2, updated_at: updated2 });
      return;
    }

    var key = String((req.query && req.query.key) || body.key || '').trim();
    if (!ALLOWED_KEYS[key]) {
      res.status(400).json({ ok: false, error: 'key must be "reference" or "user_logs".' });
      return;
    }
    if (req.method === 'GET') {
      var rows = await sql`SELECT content, updated_at FROM user_docs WHERE email = ${email} AND doc_key = ${key} LIMIT 1`;
      var content = (rows && rows[0] && rows[0].content) || DEFAULTS[key];
      var updatedAt = (rows && rows[0] && rows[0].updated_at) || null;
      res.status(200).json({ ok: true, key: key, content: content, updated_at: updatedAt });
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      var contentIn = body.content;
      if (typeof contentIn !== 'string') {
        res.status(400).json({ ok: false, error: 'content must be a string (markdown).' });
        return;
      }
      if (contentIn.length > 100000) {
        res.status(400).json({ ok: false, error: 'content too large (max 100k characters).' });
        return;
      }
      await sql`
        INSERT INTO user_docs (email, doc_key, content, updated_at)
        VALUES (${email}, ${key}, ${contentIn}, NOW())
        ON CONFLICT (email, doc_key)
        DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()
      `;
      res.status(200).json({ ok: true, key: key, saved: true });
      return;
    }
    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('[docs]', err);
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err).slice(0, 300) });
  }
};

module.exports.config = { maxDuration: 15 };
