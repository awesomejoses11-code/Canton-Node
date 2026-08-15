/* =========================================================================
 * quota.js — Client-side daily rate limiter (localStorage)
 *
 * Every specialist agent MUST call `Quota.consume(feature)` (via api.js)
 * before hitting Prexzy, so the platform stays inside the free-tier limits
 * we agreed on.
 *
 * v4 (2026-08-15):
 *   • `master` and `text` are unlimited (null limit) — multi-model routing
 *     is sustainable enough for liberal use. Other features keep hard caps.
 *
 * Storage shape (localStorage key `prexzy.quota.v2.<scope>`):
 *   {
 *     "date": "2026-08-12",
 *     "counters": { "master": 4, "text": 12, "image": 1, ... }
 *   }
 * ========================================================================= */

(function (global) {
  'use strict';

  const STORAGE_PREFIX = 'prexzy.quota.v2';

  // null = unlimited (never blocks). Keep keys stable for UI + api.js.
  const LIMITS = Object.freeze({
    master:     null,
    text:       null,
    tts:        50,
    code:       50,
    web:        30,
    image2html: 25,
    html2image: 15,
    image:      12,
    music:       8,
    video:       4
  });

  const LABELS = Object.freeze({
    master:     'Master Agent routing',
    text:       'AI Chat / Writer / Text',
    tts:        'Text-to-Speech',
    code:       'Code compile / convert',
    web:        'Web / Internet agent',
    image2html: 'Image → HTML',
    html2image: 'HTML → Image',
    image:      'Image generation',
    music:      'Music / Song generation',
    video:      'Video generation'
  });

  let _scope = 'anon';
  function storageKey() { return `${STORAGE_PREFIX}.${_scope}`; }

  function todayStr() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  function readState() {
    let raw = null;
    try { raw = localStorage.getItem(storageKey()); } catch (_) {}

    let state = null;
    if (raw) {
      try { state = JSON.parse(raw); } catch (_) { state = null; }
    }

    const today = todayStr();
    if (!state || state.date !== today) {
      state = { date: today, counters: {} };
    }
    for (const key of Object.keys(LIMITS)) {
      if (typeof state.counters[key] !== 'number') state.counters[key] = 0;
    }
    return state;
  }

  function writeState(state) {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(state));
    } catch (_) {
      _memoryState = state;
    }
  }

  let _memoryState = null;

  const Quota = {
    setScope(scope) {
      _scope = String(scope || 'anon').toLowerCase();
      _memoryState = null;
      _emitChange();
    },

    features() {
      return Object.keys(LIMITS);
    },

    limit(feature) {
      if (!(feature in LIMITS)) return 0;
      return LIMITS[feature];
    },

    isUnlimited(feature) {
      return feature in LIMITS && LIMITS[feature] == null;
    },

    label(feature) {
      return LABELS[feature] || feature;
    },

    used(feature) {
      const s = readState();
      return s.counters[feature] || 0;
    },

    remaining(feature) {
      if (this.isUnlimited(feature)) return Infinity;
      return Math.max(0, this.limit(feature) - this.used(feature));
    },

    consume(feature) {
      if (!(feature in LIMITS)) {
        return { ok: false, reason: 'unknown-feature', remaining: 0 };
      }
      const state = readState();
      const used = state.counters[feature] || 0;
      const lim = LIMITS[feature];
      if (lim != null && used >= lim) {
        return { ok: false, reason: 'exhausted', remaining: 0 };
      }
      state.counters[feature] = used + 1;
      writeState(state);
      _emitChange();
      return {
        ok: true,
        remaining: lim == null ? Infinity : lim - state.counters[feature]
      };
    },

    refund(feature) {
      if (!(feature in LIMITS)) return;
      const state = readState();
      state.counters[feature] = Math.max(0, (state.counters[feature] || 0) - 1);
      writeState(state);
      _emitChange();
    },

    snapshot() {
      const s = readState();
      return Object.keys(LIMITS).map(key => {
        const lim = LIMITS[key];
        const used = s.counters[key] || 0;
        return {
          key,
          label: LABELS[key],
          used,
          limit: lim,
          unlimited: lim == null,
          remaining: lim == null ? Infinity : Math.max(0, lim - used),
          date: s.date
        };
      });
    },

    onChange(fn) {
      _listeners.add(fn);
      return () => _listeners.delete(fn);
    }
  };

  const _listeners = new Set();
  function _emitChange() {
    for (const fn of _listeners) {
      try { fn(Quota.snapshot()); } catch (e) { console.error('[quota] listener', e); }
    }
  }

  function scheduleMidnightRefresh() {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2);
    setTimeout(() => {
      _emitChange();
      scheduleMidnightRefresh();
    }, midnight.getTime() - now.getTime());
  }
  scheduleMidnightRefresh();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) _emitChange();
  });

  global.Quota = Quota;

})(window);
