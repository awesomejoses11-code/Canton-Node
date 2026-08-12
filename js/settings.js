/* =========================================================================
 * settings.js — Per-user customization store
 *
 * NEW in this build. Settings are namespaced per account
 * (`prexzy.settings.v1.<email>`) so each user on a shared device keeps
 * their own theme, defaults and workflow preferences.
 *
 * `Settings.applyAll()` is the single place that pushes settings into the
 * DOM: theme class on <html>, accent CSS variables, compact-card class on
 * <body>. Call it after login and after every save.
 * ========================================================================= */

(function (global) {
  'use strict';

  const PREFIX = 'prexzy.settings.v1';

  const DEFAULTS = Object.freeze({
    displayName:  '',           // falls back to the account username
    theme:        'system',     // 'system' | 'light' | 'dark'
    accent:       'indigo',     // see ACCENTS
    codeLang:     'python',     // default language for the Code agent
    imageSize:    '1024x1024',  // default size for image agents
    ttsVoice:     'olivia',     // default voice for the TTS agent
    routingMode:  'auto',       // 'auto' (GPT-5.4 router) | 'manual'
    confirmHeavy: true,         // confirm before image/music/video calls
    compactCards: false         // denser agent cards
  });

  // Accent palettes — RGB triplets consumed by the Tailwind brand color vars.
  const ACCENTS = Object.freeze({
    indigo:  { 50: '238 242 255', 500: '99 102 241',  600: '79 70 229',   700: '67 56 202'  },
    violet:  { 50: '245 243 255', 500: '139 92 246',  600: '124 58 237',  700: '109 40 217' },
    emerald: { 50: '236 253 245', 500: '16 185 129',  600: '5 150 105',   700: '4 120 87'   },
    rose:    { 50: '255 241 242', 500: '244 63 94',   600: '225 29 72',   700: '190 18 60'  },
    amber:   { 50: '255 251 235', 500: '245 158 11',  600: '217 119 6',   700: '180 83 9'   }
  });

  function key(email) { return `${PREFIX}.${String(email || 'anon').toLowerCase()}`; }

  const Settings = {
    DEFAULTS,

    /** Load settings for an account, merged over defaults. */
    load(email) {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(key(email))) || {}; } catch (_) {}
      return Object.assign({}, DEFAULTS, saved);
    },

    /** Persist settings for an account. */
    save(email, settings) {
      try { localStorage.setItem(key(email), JSON.stringify(settings)); } catch (_) {}
    },

    /** Push every visual setting into the DOM. */
    applyAll(s) {
      s = Object.assign({}, DEFAULTS, s);
      this.applyTheme(s.theme);
      this.applyAccent(s.accent);
      document.body.classList.toggle('compact-cards', !!s.compactCards);
    },

    /** 'system' follows prefers-color-scheme (and live OS changes). */
    applyTheme(theme) {
      const root = document.documentElement;
      const darkQuery = global.matchMedia('(prefers-color-scheme: dark)');
      const resolve = () => {
        const dark = theme === 'dark' || (theme === 'system' && darkQuery.matches);
        root.classList.toggle('dark', dark);
      };
      if (this._themeListener) darkQuery.removeEventListener('change', this._themeListener);
      this._themeListener = resolve;
      if (theme === 'system') darkQuery.addEventListener('change', resolve);
      resolve();
    },

    /** Swap the brand color CSS variables Tailwind reads. */
    applyAccent(accent) {
      const palette = ACCENTS[accent] || ACCENTS.indigo;
      const root = document.documentElement;
      for (const [shade, rgb] of Object.entries(palette)) {
        root.style.setProperty(`--brand-${shade}`, rgb);
      }
    }
  };

  global.Settings = Settings;

})(window);
