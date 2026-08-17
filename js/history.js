/* =========================================================================
 * history.js — Chat history for Master Agent
 *
 * localStorage + Neon sync (/api/user).
 * On login: MERGE local + remote (never blindly overwrite local with a thinner server copy).
 * ========================================================================= */

(function (global) {
  'use strict';

  var MAX_SESSIONS = 100;
  var MAX_MESSAGES_PER_SESSION = 200;
  var TITLE_MAX_LEN = 48;

  function keyFor(email) {
    return 'canton_history_' + (email || 'anon');
  }

  function readAll(email) {
    try {
      var raw = localStorage.getItem(keyFor(email));
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function authToken() {
    try {
      var u = (typeof Auth !== 'undefined' && Auth.current) ? Auth.current() : null;
      if (u && u.token) return u.token;
    } catch (_) {}
    try {
      for (var i = 0; i < 2; i++) {
        var store = i === 0 ? sessionStorage : localStorage;
        var raw = store.getItem('prexzy.session.v1');
        if (!raw) continue;
        var p = JSON.parse(raw);
        if (p && p.token) return p.token;
      }
    } catch (_) {}
    return null;
  }

  function ts(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    var n = Date.parse(String(v));
    return isNaN(n) ? 0 : n;
  }

  /** Merge two message arrays by id; prefer richer / newer content. */
  function mergeMessages(a, b) {
    var map = {};
    var order = [];
    function ingest(list) {
      (list || []).forEach(function (m) {
        if (!m || !m.id) return;
        var prev = map[m.id];
        if (!prev) {
          map[m.id] = m;
          order.push(m.id);
          return;
        }
        var prevLen = String(prev.content || '').length;
        var nextLen = String(m.content || '').length;
        // Prefer longer content (server may have truncated); else newer createdAt
        if (nextLen > prevLen || (nextLen === prevLen && ts(m.createdAt) >= ts(prev.createdAt))) {
          map[m.id] = Object.assign({}, prev, m, {
            content: nextLen >= prevLen ? m.content : prev.content,
            meta: (m.meta && Object.keys(m.meta).length) ? m.meta : (prev.meta || {})
          });
        }
      });
    }
    ingest(a);
    ingest(b);
    return order.map(function (id) { return map[id]; }).slice(-MAX_MESSAGES_PER_SESSION);
  }

  /** Merge session lists by id — keep the union; prefer newer updatedAt + richer messages. */
  function mergeSessions(localList, remoteList) {
    var map = {};
    function ingest(list) {
      (list || []).forEach(function (s) {
        if (!s || !s.id) return;
        var prev = map[s.id];
        if (!prev) {
          map[s.id] = {
            id: s.id,
            title: s.title || 'Chat',
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            messages: Array.isArray(s.messages) ? s.messages.slice() : []
          };
          return;
        }
        var mergedMsgs = mergeMessages(prev.messages, s.messages);
        var newerRemote = ts(s.updatedAt) >= ts(prev.updatedAt);
        map[s.id] = {
          id: s.id,
          title: (newerRemote && s.title) ? s.title : (prev.title || s.title || 'Chat'),
          createdAt: ts(s.createdAt) && ts(prev.createdAt)
            ? (ts(s.createdAt) < ts(prev.createdAt) ? s.createdAt : prev.createdAt)
            : (s.createdAt || prev.createdAt),
          updatedAt: newerRemote ? s.updatedAt : prev.updatedAt,
          messages: mergedMsgs
        };
        // If one side has more messages, prefer that updatedAt if messages grew
        if (mergedMsgs.length > (prev.messages || []).length &&
            mergedMsgs.length > (s.messages || []).length) {
          map[s.id].updatedAt = new Date().toISOString();
        }
      });
    }
    ingest(localList);
    ingest(remoteList);
    return Object.keys(map)
      .map(function (k) { return map[k]; })
      .sort(function (a, b) { return ts(a.updatedAt) < ts(b.updatedAt) ? 1 : -1; })
      .slice(0, MAX_SESSIONS);
  }

  function pushToServer(email, sessions, opts) {
    opts = opts || {};
    var t = authToken();
    if (!t) return Promise.resolve(false);
    var body = JSON.stringify({ token: t, action: 'save', sessions: sessions });
    var attempt = function () {
      return fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: !!opts.keepalive
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (data) {
          return !!(res.ok && data && data.ok);
        });
      }).catch(function () { return false; });
    };
    return attempt().then(function (ok) {
      if (ok || !opts.retry) return ok;
      return attempt();
    });
  }

  async function pullFromServer() {
    var t = authToken();
    if (!t) return null;
    try {
      var res = await fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t, action: 'load' })
      });
      var data = await res.json().catch(function () { return null; });
      if (res.ok && data && data.ok && Array.isArray(data.sessions)) return data.sessions;
    } catch (_) {}
    return null;
  }

  function writeAll(email, sessions) {
    var capped = sessions.slice(0, MAX_SESSIONS);
    try {
      localStorage.setItem(keyFor(email), JSON.stringify(capped));
    } catch (e) {
      // Storage full — still try server
    }
    pushToServer(email, capped, { retry: true });
  }

  function makeId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function titleFrom(text) {
    var clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return 'New chat';
    return clean.length > TITLE_MAX_LEN ? clean.slice(0, TITLE_MAX_LEN).trim() + '…' : clean;
  }

  var History = {

    load: function (email) {
      return readAll(email).sort(function (a, b) {
        return ts(a.updatedAt) < ts(b.updatedAt) ? 1 : -1;
      });
    },

    /**
     * Pull server history and MERGE with localStorage.
     * Never replace a richer local set with a thinner remote copy.
     * After merge, push unified set back to server so backup is complete.
     */
    syncFromServer: async function (email) {
      var local = readAll(email);
      var remote = await pullFromServer();
      if (!remote) return this.load(email);

      var merged = mergeSessions(local, remote);
      try {
        localStorage.setItem(keyFor(email), JSON.stringify(merged));
      } catch (_) {}

      // Heal server if local (or merge) had sessions the server was missing
      var remoteIds = {};
      (remote || []).forEach(function (s) { if (s && s.id) remoteIds[s.id] = true; });
      var localHadMore = merged.length > (remote || []).length;
      var missingOnServer = merged.some(function (s) { return s && s.id && !remoteIds[s.id]; });
      if (localHadMore || missingOnServer) {
        await pushToServer(email, merged, { retry: true });
      }

      return this.load(email);
    },

    /** Force full backup of current local sessions to server. */
    backupNow: async function (email) {
      var sessions = readAll(email);
      var ok = await pushToServer(email, sessions, { retry: true });
      return { ok: ok, count: sessions.length };
    },

    get: function (email, sessionId) {
      return readAll(email).find(function (s) { return s.id === sessionId; }) || null;
    },

    create: function (email, firstMessageText) {
      var now = new Date().toISOString();
      var session = {
        id: makeId(),
        title: titleFrom(firstMessageText),
        createdAt: now,
        updatedAt: now,
        messages: []
      };
      var all = readAll(email);
      all.unshift(session);
      writeAll(email, all);
      return session;
    },

    appendMessage: function (email, sessionId, message) {
      var all = readAll(email);
      var session = all.find(function (s) { return s.id === sessionId; });
      if (!session) return null;
      session.messages.push(message);
      if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
        session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
      }
      session.updatedAt = new Date().toISOString();
      writeAll(email, all);
      return session;
    },

    updateMessage: function (email, sessionId, messageId, patch) {
      var all = readAll(email);
      var session = all.find(function (s) { return s.id === sessionId; });
      if (!session) return null;
      var msg = session.messages.find(function (m) { return m.id === messageId; });
      if (!msg) return null;
      Object.assign(msg, patch);
      session.updatedAt = new Date().toISOString();
      writeAll(email, all);
      return msg;
    },

    delete: function (email, sessionId) {
      writeAll(email, readAll(email).filter(function (s) { return s.id !== sessionId; }));
    },

    makeId: makeId
  };

  // Best-effort flush before tab close
  try {
    window.addEventListener('beforeunload', function () {
      try {
        var u = (typeof Auth !== 'undefined' && Auth.current) ? Auth.current() : null;
        var em = u && u.email;
        if (!em) return;
        var sessions = readAll(em);
        if (!sessions.length) return;
        pushToServer(em, sessions, { keepalive: true });
      } catch (_) {}
    });
  } catch (_) {}

  global.History = History;

})(window);
