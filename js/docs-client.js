/* =========================================================================
 * js/docs-client.js — Client for Neon-backed reference.md + user_logs.md
 * ========================================================================= */
(function (global) {
  'use strict';

  function token() {
    var s = (window.Auth && Auth.current && Auth.current()) || null;
    if (s && s.token) return s.token;
    try {
      for (var i = 0; i < 2; i++) {
        var store = i === 0 ? sessionStorage : localStorage;
        var raw = store.getItem('prexzy.session.v1');
        if (!raw) continue;
        var parsed = JSON.parse(raw);
        if (parsed && parsed.token) return parsed.token;
      }
    } catch (_) {}
    return null;
  }

  async function list() {
    var t = token();
    if (!t) return { ok: false, error: 'Not signed in', code: 'no_session' };
    var res = await fetch('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: t, action: 'list' })
    });
    var data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok || !data || !data.ok) {
      return { ok: false, error: (data && data.error) || ('HTTP ' + res.status), code: data && data.code };
    }
    return data;
  }

  async function get(key) {
    var t = token();
    if (!t) return { ok: false, error: 'Not signed in', code: 'no_session' };
    var res = await fetch('/api/user?key=' + encodeURIComponent(key) + '&token=' + encodeURIComponent(t));
    var data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok || !data || !data.ok) {
      return { ok: false, error: (data && data.error) || ('HTTP ' + res.status), code: data && data.code };
    }
    return data;
  }

  async function save(key, content) {
    var t = token();
    if (!t) return { ok: false, error: 'Not signed in', code: 'no_session' };
    var res = await fetch('/api/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: t, key: key, content: content })
    });
    var data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok || !data || !data.ok) {
      return { ok: false, error: (data && data.error) || ('HTTP ' + res.status), code: data && data.code };
    }
    return data;
  }

  global.DocsClient = { list: list, get: get, save: save };
})(window);
