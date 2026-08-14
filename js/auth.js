/* =========================================================================
 * auth.js — Server-first auth (Neon) with localStorage fallback
 *
 * Priority:
 *   1. /api/auth  action=register|login|me  (cross-device via Neon)
 *   2. localStorage users (private device gate if DB unavailable)
 *
 * Session shape (both stores):
 *   { email, username, token?, issuedAt, expiresAt|null }
 * ========================================================================= */

(function (global) {
  'use strict';

  const USERS_KEY   = 'prexzy.users.v1';
  const SESSION_KEY = 'prexzy.session.v1';
  const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

  async function sha256(text) {
    if (global.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return 'fnv' + h.toString(16);
  }

  function makeSalt() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function readUsers() {
    try { return JSON.parse(localStorage.getItem(USERS_KEY)) || {}; }
    catch (_) { return {}; }
  }
  function writeUsers(users) {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  }

  function writeSession(session, persistent) {
    clearSession();
    const store = persistent ? localStorage : sessionStorage;
    try { store.setItem(SESSION_KEY, JSON.stringify(session)); } catch (_) {}
  }

  function readSession() {
    for (const store of [sessionStorage, localStorage]) {
      let raw = null;
      try { raw = store.getItem(SESSION_KEY); } catch (_) { continue; }
      if (!raw) continue;
      try {
        const s = JSON.parse(raw);
        if (s && s.email && (!s.expiresAt || s.expiresAt > Date.now())) return s;
        store.removeItem(SESSION_KEY);
      } catch (_) {}
    }
    return null;
  }

  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
  }

  async function serverAuth(action, body) {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, body || {}))
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { res: res, data: data };
  }

  const Auth = {
    async register(email, username, password, remember) {
      email = String(email || '').trim().toLowerCase();
      username = String(username || '').trim();
      if (!email || !email.includes('@')) throw new Error('Enter a valid email address.');
      if (!username) throw new Error('Pick a user name.');
      if (String(password).length < 6) throw new Error('Password must be at least 6 characters.');

      // Prefer Neon
      try {
        const { res, data } = await serverAuth('register', {
          email: email, username: username, password: password
        });
        if (res.ok && data && data.ok && data.user) {
          return this._startSession(data.user, remember, data.token, data.expiresAt);
        }
        // 409 / 400 with message — surface to UI (don't fall back silently)
        if (data && data.error && data.code !== 'no_db') {
          throw new Error(data.error);
        }
        // no_db or network → fall through to local
      } catch (err) {
        if (err && err.message && !/fetch|network|Failed to fetch|no_db/i.test(err.message) &&
            !/DATABASE_URL/i.test(err.message)) {
          throw err;
        }
      }

      // Local fallback
      const users = readUsers();
      if (users[email]) throw new Error('An account with this email already exists. Sign in instead.');
      const salt = makeSalt();
      users[email] = {
        email: email, username: username, salt: salt,
        hash: await sha256(salt + ':' + password),
        createdAt: Date.now()
      };
      writeUsers(users);
      return this._startSession(users[email], remember, null, null);
    },

    async login(email, password, remember) {
      email = String(email || '').trim().toLowerCase();

      try {
        const { res, data } = await serverAuth('login', {
          email: email, password: password
        });
        if (res.ok && data && data.ok && data.user) {
          return this._startSession(data.user, remember, data.token, data.expiresAt);
        }
        if (data && data.error && data.code !== 'no_db') {
          throw new Error(data.error);
        }
      } catch (err) {
        if (err && err.message && !/fetch|network|Failed to fetch|no_db|DATABASE_URL/i.test(err.message)) {
          throw err;
        }
      }

      const user = readUsers()[email];
      if (!user) throw new Error('No account found for this email. Register first.');
      const hash = await sha256(user.salt + ':' + password);
      if (hash !== user.hash) throw new Error('Incorrect password.');
      return this._startSession(user, remember, null, null);
    },

    logout() { clearSession(); },

    current() {
      const s = readSession();
      if (!s) return null;
      return { email: s.email, username: s.username, token: s.token || null };
    },

    /** Optional: refresh server session when a token exists */
    async refresh() {
      const s = readSession();
      if (!s || !s.token) return this.current();
      try {
        const { res, data } = await serverAuth('me', { token: s.token });
        if (res.ok && data && data.ok && data.user) {
          const persistent = !!localStorage.getItem(SESSION_KEY);
          return this._startSession(data.user, persistent, s.token, data.expiresAt);
        }
        if (res.status === 401) clearSession();
      } catch (_) {}
      return this.current();
    },

    _startSession(user, remember, token, expiresAtIso) {
      const session = {
        email: user.email,
        username: user.username,
        token: token || null,
        issuedAt: Date.now(),
        expiresAt: expiresAtIso
          ? new Date(expiresAtIso).getTime()
          : (remember ? Date.now() + SESSION_TTL : null)
      };
      writeSession(session, !!remember);
      return { email: user.email, username: user.username, token: session.token };
    }
  };

  global.Auth = Auth;

})(window);
