/* =========================================================================
 * settings.js — Per-user customization store
 *
 * Settings are namespaced per account (`prexzy.settings.v1.<email>`) so each
 * user on a shared device keeps their own theme, tone, and defaults.
 *
 * Settings.applyAll() pushes visual settings into the DOM. Call after login
 * and after every save.
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

  const Settings = {
    DEFAULTS,
    TONES,

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
      var self = this;
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
