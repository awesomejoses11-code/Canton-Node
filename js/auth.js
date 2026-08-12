/* =========================================================================
 * auth.js — Client-side auth with session persistence
 *
 * NEW in this build. The hub now sits behind a sign-in screen and the
 * session survives reloads:
 *
 *   • "Keep me signed in" checked  → session in localStorage (30 days)
 *   • unchecked                    → session in sessionStorage (tab only)
 *
 * Passwords are never stored in plain text — we keep a salted SHA-256 hash
 * per registered account in localStorage (`prexzy.users.v1`). This is a
 * private-device gate, NOT real server security; it exists to keep casual
 * eyes out of a shared browser profile.
 *
 * Storage:
 *   prexzy.users.v1            { "<email>": { username, email, salt, hash, createdAt } }
 *   prexzy.session.v1 (ls/ss)  { email, username, issuedAt, expiresAt|null }
 * ========================================================================= */

(function (global) {
  'use strict';

  const USERS_KEY   = 'prexzy.users.v1';
  const SESSION_KEY = 'prexzy.session.v1';
  const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days for "keep me signed in"

  // ---- Crypto helpers ------------------------------------------------------

  async function sha256(text) {
    if (global.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    // Non-crypto fallback (old browsers / file:// without secure context):
    // simple FNV-1a — fine for a private device gate, not for real secrets.
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

  // ---- User store ----------------------------------------------------------

  function readUsers() {
    try { return JSON.parse(localStorage.getItem(USERS_KEY)) || {}; }
    catch (_) { return {}; }
  }
  function writeUsers(users) {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  }

  // ---- Session store ---------------------------------------------------------

  function writeSession(session, persistent) {
    clearSession();
    const store = persistent ? localStorage : sessionStorage;
    try { store.setItem(SESSION_KEY, JSON.stringify(session)); } catch (_) {}
  }

  function readSession() {
    // Tab-scoped session wins over the persistent one.
    for (const store of [sessionStorage, localStorage]) {
      let raw = null;
      try { raw = store.getItem(SESSION_KEY); } catch (_) { continue; }
      if (!raw) continue;
      try {
        const s = JSON.parse(raw);
        if (s && s.email && (!s.expiresAt || s.expiresAt > Date.now())) return s;
        store.removeItem(SESSION_KEY); // expired → clean up
      } catch (_) { /* corrupt entry */ }
    }
    return null;
  }

  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
  }

  // ---- Public API ----------------------------------------------------------

  const Auth = {
    /** Create a new account. Throws on duplicate email / weak input. */
    async register(email, username, password, remember) {
      email = String(email || '').trim().toLowerCase();
      username = String(username || '').trim();
      if (!email || !email.includes('@')) throw new Error('Enter a valid email address.');
      if (!username) throw new Error('Pick a user name.');
      if (String(password).length < 6) throw new Error('Password must be at least 6 characters.');

      const users = readUsers();
      if (users[email]) throw new Error('An account with this email already exists. Sign in instead.');

      const salt = makeSalt();
      users[email] = {
        email, username, salt,
        hash: await sha256(salt + ':' + password),
        createdAt: Date.now()
      };
      writeUsers(users);
      return this._startSession(users[email], remember);
    },

    /** Verify credentials and start a session. Throws on bad credentials. */
    async login(email, password, remember) {
      email = String(email || '').trim().toLowerCase();
      const user = readUsers()[email];
      if (!user) throw new Error('No account found for this email. Register first.');
      const hash = await sha256(user.salt + ':' + password);
      if (hash !== user.hash) throw new Error('Incorrect password.');
      return this._startSession(user, remember);
    },

    /** End the session (both stores) — next load shows the sign-in screen. */
    logout() { clearSession(); },

    /** The currently signed-in user object, or null. Restores the session. */
    current() {
      const s = readSession();
      if (!s) return null;
      const user = readUsers()[s.email];
      return user ? { email: user.email, username: user.username } : null;
    },

    _startSession(user, remember) {
      const session = {
        email: user.email,
        username: user.username,
        issuedAt: Date.now(),
        expiresAt: remember ? Date.now() + SESSION_TTL : null
      };
      writeSession(session, !!remember);
      return { email: user.email, username: user.username };
    }
  };

  global.Auth = Auth;

})(window);
