/* =========================================================================
 * history.js — Chat history storage for the Master Agent
 *
 * Pure storage layer, no DOM. Sessions are stored per-user in localStorage,
 * mirroring the Settings.load(email)/save(email, s) pattern used elsewhere
 * in the app. All rendering/wiring lives in master-client.js — this file
 * only knows how to persist and retrieve sessions.
 *
 * Storage shape (per user, key: canton_history_<email>):
 *   [ { id, title, createdAt, updatedAt, messages: [
 *         { id, role: 'user' | 'assistant', kind: 'text' | 'route',
 *           content, meta, createdAt }
 *   ] } ]
 *
 * No projects, no artifacts — just flat, linear chats. Newest-updated
 * session sorts first. Capped at MAX_SESSIONS / MAX_MESSAGES_PER_SESSION
 * so a long-lived account doesn't grow localStorage without bound.
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

  function writeAll(email, sessions) {
    try {
      localStorage.setItem(keyFor(email), JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
    } catch (e) {
      // Storage full/unavailable (e.g. private browsing) — fail silently,
      // the chat still works for the current tab, it just won't persist.
    }
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

    /** All sessions for a user, newest-updated first. */
    load(email) {
      return readAll(email).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },

    /** One session by id, or null. */
    get(email, sessionId) {
      return readAll(email).find(s => s.id === sessionId) || null;
    },

    /** Create a new session titled from the first message, persist, return it. */
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

    /** Append a message to a session, persist, return the updated session (or null if missing). */
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

    /** Patch fields on one message in place (e.g. after "Execute on Prexzy"). */
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

    /** Delete a session outright. */
    delete(email, sessionId) {
      writeAll(email, readAll(email).filter(s => s.id !== sessionId));
    },

    makeId
  };

  global.History = History;

})(window);
