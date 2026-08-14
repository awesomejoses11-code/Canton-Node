/* =========================================================================
 * api/history.js — Cross-device chat history on Neon
 * POST { token, action: "load"|"save", sessions? }
 * ========================================================================= */
var db = require('./db');

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

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Method not allowed' });
      return;
    }
    if (!db.hasDatabase()) {
      res.status(503).json({ ok: false, error: 'DATABASE_URL not configured', code: 'no_db' });
      return;
    }
    await db.ensureSchema();
    var sql = db.getSql();
    var body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    var token = String(body.token || '').trim();
    var email = await resolveEmail(token);
    if (!email) {
      res.status(401).json({ ok: false, error: 'Invalid or expired session', code: 'auth' });
      return;
    }

    var action = String(body.action || 'load').toLowerCase();
    if (action === 'load') {
      var rows = await sql`SELECT sessions FROM chat_history WHERE email = ${email} LIMIT 1`;
      var sessions = (rows && rows[0] && rows[0].sessions) ? rows[0].sessions : [];
      if (typeof sessions === 'string') {
        try { sessions = JSON.parse(sessions); } catch (_) { sessions = []; }
      }
      if (!Array.isArray(sessions)) sessions = [];
      res.status(200).json({ ok: true, sessions: sessions });
      return;
    }

    if (action === 'save') {
      var sessions = Array.isArray(body.sessions) ? body.sessions : [];
      sessions = sessions.slice(0, 100).map(function (s) {
        if (!s || typeof s !== 'object') return null;
        var msgs = Array.isArray(s.messages) ? s.messages.slice(-200) : [];
        return {
          id: s.id,
          title: String(s.title || 'Chat').slice(0, 80),
          createdAt: s.createdAt || Date.now(),
          updatedAt: s.updatedAt || Date.now(),
          messages: msgs.map(function (m) {
            return {
              id: m.id,
              role: m.role,
              kind: m.kind || 'text',
              content: String(m.content || '').slice(0, 8000),
              meta: m.meta && typeof m.meta === 'object' ? { attachmentName: m.meta.attachmentName } : {},
              createdAt: m.createdAt || Date.now()
            };
          })
        };
      }).filter(Boolean);

      await sql`
        INSERT INTO chat_history (email, sessions, updated_at)
        VALUES (${email}, ${JSON.stringify(sessions)}::jsonb, NOW())
        ON CONFLICT (email) DO UPDATE SET
          sessions = EXCLUDED.sessions,
          updated_at = NOW()
      `;
      res.status(200).json({ ok: true, count: sessions.length });
      return;
    }

    res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('[history]', err);
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err).slice(0, 300) });
  }
};
