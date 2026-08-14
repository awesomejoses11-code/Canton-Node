/* =========================================================================
 * history.js — Chat history storage for the Master Agent
 *
 * localStorage + optional Neon sync (/api/user) when session token exists.
 * ========================================================================= */

(function (global) {
  'use strict';

  const MAX_SESSIONS = 100;
  const MAX_MESSAGES_PER_SESSION = 200;
  const TITLE_MAX_LEN = 48;

  function keyFor(email) {
    return 'canton_history_' + (email || 'anon');
  }

  function readAll(email) {
    try {
      const raw = localStorage.getItem(keyFor(email));
      const parsed = raw ? JSON.parse(raw) : [];
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

  function pushToServer(email, sessions) {
    var t = authToken();
    if (!t) return;
    try {
      fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t, action: 'save', sessions: sessions })
      }).catch(function () {});
    } catch (_) {}
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
      // Storage full/unavailable — still try server.
    }
    pushToServer(email, capped);
  }

  function makeId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function titleFrom(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return 'New chat';
    return clean.length > TITLE_MAX_LEN ? clean.slice(0, TITLE_MAX_LEN).trim() + '…' : clean;
  }

  const History = {

    load(email) {
      return readAll(email).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },

    /** Pull server history into localStorage (cross-device). */
    async syncFromServer(email) {
      var remote = await pullFromServer();
      if (!remote) return this.load(email);
      try {
        localStorage.setItem(keyFor(email), JSON.stringify(remote.slice(0, MAX_SESSIONS)));
      } catch (_) {}
      return this.load(email);
    },

    get(email, sessionId) {
      return readAll(email).find(s => s.id === sessionId) || null;
    },

    create(email, firstMessageText) {
      const now = new Date().toISOString();
      const session = {
        id: makeId(),
        title: titleFrom(firstMessageText),
        createdAt: now,
        updatedAt: now,
        messages: []
      };
      const all = readAll(email);
      all.unshift(session);
      writeAll(email, all);
      return session;
    },

    appendMessage(email, sessionId, message) {
      const all = readAll(email);
      const session = all.find(s => s.id === sessionId);
      if (!session) return null;
      session.messages.push(message);
      if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
        session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
      }
      session.updatedAt = new Date().toISOString();
      writeAll(email, all);
      return session;
    },

    updateMessage(email, sessionId, messageId, patch) {
      const all = readAll(email);
      const session = all.find(s => s.id === sessionId);
      if (!session) return null;
      const msg = session.messages.find(m => m.id === messageId);
      if (!msg) return null;
      Object.assign(msg, patch);
      session.updatedAt = new Date().toISOString();
      writeAll(email, all);
      return msg;
    },

    delete(email, sessionId) {
      writeAll(email, readAll(email).filter(s => s.id !== sessionId));
    },

    makeId
  };

  global.History = History;

})(window);
