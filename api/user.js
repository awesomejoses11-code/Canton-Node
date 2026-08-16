/* =========================================================================
 * api/user.js — Combined Neon user data (chat history + memory docs + settings)
 * Replaces api/history.js + api/docs.js to stay under Vercel Hobby 12-fn limit.
 *
 * History:  POST { token, action: "load"|"save", sessions? }
 * Docs:     GET/POST with key=reference|user_logs|settings or action=list
 * Memory:   POST { token, action: "reindex_memory" }  — rebuild pgvector chunks
 * ========================================================================= */

var db = require('../lib/db');

var ALLOWED_KEYS = { reference: true, user_logs: true, settings: true };

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
    '(Master may append light notes when memory is enabled.)\n',
  settings: JSON.stringify({
    displayName: '',
    tone: 'friendly',
    theme: 'system',
    accent: 'indigo',
    codeLang: 'python',
    imageSize: '1024x1024',
    ttsVoice: 'olivia',
    routingMode: 'auto',
    confirmHeavy: true,
    compactCards: false,
    memoryEnabled: true
  })
};

async function resolveEmail(token) {
  return db.resolveEmailFromToken(token);
}

function extractToken(req, body) {
  var t =
    (body && body.token) ||
    (req.query && req.query.token) ||
    (req.headers.authorization && String(req.headers.authorization).replace(/^Bearer\s+/i, '')) ||
    '';
  return String(t || '').trim();
}

async function maybeReindex(email, key, content) {
  if (key !== 'reference' && key !== 'user_logs') return null;
  try {
    var memoryIndex = require('../lib/memory-index');
    var result = await memoryIndex.reindexSource(email, key, content);
    return result;
  } catch (e) {
    console.error('[user] memory reindex', e && e.message);
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

async function handleHistory(req, res, email, body) {
  var sql = db.getSql();
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

  res.status(400).json({ ok: false, error: 'Unknown history action' });
}

async function handleReindexMemory(res, email) {
  var sql = db.getSql();
  var rows = await sql`
    SELECT doc_key, content FROM user_docs
    WHERE email = ${email} AND doc_key IN ('reference', 'user_logs')
  `;
  var memoryIndex = require('../lib/memory-index');
  var results = {};
  var keys = ['reference', 'user_logs'];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var found = (rows || []).find(function (r) { return r.doc_key === key; });
    var content = found ? found.content : (DEFAULTS[key] || '');
    results[key] = await memoryIndex.reindexSource(email, key, content);
  }
  res.status(200).json({ ok: true, reindexed: results });
}

async function handleDocs(req, res, email, body) {
  var sql = db.getSql();

  if ((req.method === 'GET' && req.query && req.query.action === 'list') ||
      (req.method === 'POST' && body.action === 'list')) {
    var all = await sql`SELECT doc_key, content, updated_at FROM user_docs WHERE email = ${email}`;
    var map = {
      reference: DEFAULTS.reference,
      user_logs: DEFAULTS.user_logs,
      settings: DEFAULTS.settings
    };
    var updated = {};
    (all || []).forEach(function (row) {
      map[row.doc_key] = row.content;
      updated[row.doc_key] = row.updated_at;
    });
    res.status(200).json({ ok: true, docs: map, updated_at: updated });
    return;
  }

  var key = String((req.query && req.query.key) || body.key || '').trim();
  if (!ALLOWED_KEYS[key]) {
    res.status(400).json({ ok: false, error: 'key must be "reference", "user_logs", or "settings".' });
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
      res.status(400).json({ ok: false, error: 'content must be a string (markdown or JSON).' });
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
    var reindex = await maybeReindex(email, key, contentIn);
    res.status(200).json({
      ok: true,
      key: key,
      saved: true,
      memory_indexed: reindex && reindex.ok ? reindex.count : 0,
      memory_index: reindex || null
    });
    return;
  }

  res.status(405).json({ ok: false, error: 'Method not allowed' });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }

    if (!db.hasDatabase()) {
      res.status(503).json({ ok: false, error: 'DATABASE_URL not configured', code: 'no_db' });
      return;
    }
    await db.ensureSchema();

    var body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    }

    var token = extractToken(req, body);
    var email = await resolveEmail(token);
    if (!email) {
      res.status(401).json({ ok: false, error: 'Invalid or expired session', code: 'auth' });
      return;
    }

    var action = String(body.action || (req.query && req.query.action) || '').toLowerCase();
    if (action === 'load' || action === 'save') {
      if (req.method !== 'POST') {
        res.status(405).json({ ok: false, error: 'Method not allowed' });
        return;
      }
      return handleHistory(req, res, email, body);
    }

    if (action === 'reindex_memory') {
      if (req.method !== 'POST') {
        res.status(405).json({ ok: false, error: 'Method not allowed' });
        return;
      }
      return handleReindexMemory(res, email);
    }

    return handleDocs(req, res, email, body);
  } catch (err) {
    console.error('[user]', err);
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err).slice(0, 300) });
  }
};

module.exports.config = { maxDuration: 60 };
