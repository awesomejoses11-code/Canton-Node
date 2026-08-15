/* =========================================================================
 * settings.js — Per-user customization store
 *
 * Local cache: prexzy.settings.v1.<email>
 * Server:     /api/user key=settings (JSON string) when session token exists
 * ========================================================================= */

(function (global) {
  'use strict';

  const PREFIX = 'prexzy.settings.v1';

  const DEFAULTS = Object.freeze({
    displayName:  '',
    tone:         'friendly',
    theme:        'system',
    accent:       'indigo',
    codeLang:     'python',
    imageSize:    '1024x1024',
    ttsVoice:     'olivia',
    routingMode:  'auto',
    /** Preferred chat provider: auto | zhipu | vinci | openrouter */
    llmProvider:  'auto',
    confirmHeavy: true,
    compactCards: false,
    memoryEnabled: true
  });

  const TONES = Object.freeze({
    friendly:     'warm, approachable, and encouraging',
    professional: 'professional, clear, and businesslike',
    concise:      'brief and to the point — minimize filler',
    technical:    'precise and technical; prefer exact terms',
    playful:      'light, witty, and informal without being unhelpful'
  });

  const ACCENTS = Object.freeze({
    indigo:  { 50: '238 242 255', 500: '99 102 241',  600: '79 70 229',   700: '67 56 202'  },
    violet:  { 50: '245 243 255', 500: '139 92 246',  600: '124 58 237',  700: '109 40 217' },
    emerald: { 50: '236 253 245', 500: '16 185 129',  600: '5 150 105',   700: '4 120 87'   },
    rose:    { 50: '255 241 242', 500: '244 63 94',   600: '225 29 72',   700: '190 18 60'  },
    amber:   { 50: '255 251 235', 500: '245 158 11',  600: '217 119 6',   700: '180 83 9'   }
  });

  function key(email) { return PREFIX + '.' + String(email || 'anon').toLowerCase(); }

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

  function pushToServer(settings) {
    var t = authToken();
    if (!t) return;
    try {
      fetch('/api/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t, key: 'settings', content: JSON.stringify(settings) })
      }).catch(function () {});
    } catch (_) {}
  }

  async function pullFromServer() {
    var t = authToken();
    if (!t) return null;
    try {
      var res = await fetch('/api/user?key=settings&token=' + encodeURIComponent(t));
      var data = await res.json().catch(function () { return null; });
      if (!res.ok || !data || !data.ok || typeof data.content !== 'string') return null;
      try {
        var parsed = JSON.parse(data.content);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (_) {}
    } catch (_) {}
    return null;
  }

  const Settings = {
    DEFAULTS: DEFAULTS,
    TONES: TONES,

    displayNameFor: function (email, user) {
      var s = this.load(email);
      return (s.displayName && s.displayName.trim()) || (user && user.username) || 'there';
    },

    toneInstruction: function (email) {
      var s = this.load(email);
      return TONES[s.tone] || TONES.friendly;
    },

    load: function (email) {
      var saved = {};
      try { saved = JSON.parse(localStorage.getItem(key(email))) || {}; } catch (_) {}
      return Object.assign({}, DEFAULTS, saved);
    },

    save: function (email, settings) {
      try { localStorage.setItem(key(email), JSON.stringify(settings)); } catch (_) {}
      pushToServer(settings);
    },

    /** Pull Neon settings into local cache (call after login). */
    syncFromServer: async function (email) {
      var remote = await pullFromServer();
      if (!remote) return this.load(email);
      var merged = Object.assign({}, DEFAULTS, remote);
      try { localStorage.setItem(key(email), JSON.stringify(merged)); } catch (_) {}
      return merged;
    },

    applyAll: function (s) {
      s = Object.assign({}, DEFAULTS, s);
      this.applyTheme(s.theme);
      this.applyAccent(s.accent);
      document.body.classList.toggle('compact-cards', !!s.compactCards);
    },

    applyTheme: function (theme) {
      var root = document.documentElement;
      var darkQuery = global.matchMedia('(prefers-color-scheme: dark)');
      var resolve = function () {
        var dark = theme === 'dark' || (theme === 'system' && darkQuery.matches);
        root.classList.toggle('dark', dark);
      };
      if (this._themeListener) darkQuery.removeEventListener('change', this._themeListener);
      this._themeListener = resolve;
      if (theme === 'system') darkQuery.addEventListener('change', resolve);
      resolve();
    },

    applyAccent: function (accent) {
      var palette = ACCENTS[accent] || ACCENTS.indigo;
      var root = document.documentElement;
      Object.keys(palette).forEach(function (shade) {
        root.style.setProperty('--brand-' + shade, palette[shade]);
      });
    }
  };

  global.Settings = Settings;

})(window);
