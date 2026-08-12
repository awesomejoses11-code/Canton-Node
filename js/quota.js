/* =========================================================================
 * quota.js — Client-side daily rate limiter (localStorage)
 *
 * Every specialist agent MUST call `Quota.consume(feature)` (via api.js)
 * before hitting Prexzy, so the platform stays inside the free-tier limits
 * we agreed on.
 *
 * Storage shape (localStorage key `prexzy.quota.v1`):
 *   {
 *     "date": "2026-08-12",         // local date, YYYY-MM-DD
 *     "counters": {
 *       "text":  12,
 *       "tts":   3,
 *       "image": 1,
 *        ...
 *     }
 *   }
 *
 * Anything from a different date is dropped and the counters are reset.
 * ========================================================================= */

(function (global) {
  'use strict';

  const STORAGE_KEY = 'prexzy.quota.v1';

  // ---- Daily limits (from the project spec) --------------------------------
  //
  // Keys are STABLE identifiers used throughout the codebase.
  // If you ever rename one here, also rename it in tools.json / api.js.
  const LIMITS = Object.freeze({
    text:       80,   // AI chat / writer / text
    tts:        60,   // Text-to-speech
    code:       50,   // Code compile / convert
    web:        40,   // Web / Internet agent
    image2html: 25,   // Image → HTML (composed vision + html gen)
    html2image: 25,   // HTML → Image
    image:      10,   // Image generation
    music:       8,   // Music / song generation
    video:       3    // Video generation
  });

  // Human-friendly labels for the dashboard.
  const LABELS = Object.freeze({
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

  // ---- Internal helpers ----------------------------------------------------

  /** Returns YYYY-MM-DD in local time (matches user's calendar day). */
  function todayStr() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  /** Read the state from localStorage, resetting if the day has changed. */
  function readState() {
    let raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (_) { /* private mode */ }

    let state = null;
    if (raw) {
      try { state = JSON.parse(raw); } catch (_) { state = null; }
    }

    const today = todayStr();
    if (!state || state.date !== today) {
      state = { date: today, counters: {} };
    }
    // Guarantee every known feature has a counter entry (makes UI simpler).
    for (const key of Object.keys(LIMITS)) {
      if (typeof state.counters[key] !== 'number') state.counters[key] = 0;
    }
    return state;
  }

  function writeState(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {
      // If storage is unavailable we degrade to in-memory only.
      _memoryState = state;
    }
  }

  // Fallback for environments without localStorage (private tabs, etc.).
  let _memoryState = null;

  // ---- Public API ----------------------------------------------------------

  const Quota = {
    /** All defined feature keys, in display order. */
    features() {
      return Object.keys(LIMITS);
    },

    /** Daily limit for a feature (0 if unknown). */
    limit(feature) {
      return LIMITS[feature] || 0;
    },

    /** Human label for a feature. */
    label(feature) {
      return LABELS[feature] || feature;
    },

    /** How many calls have been consumed today. */
    used(feature) {
      const s = readState();
      return s.counters[feature] || 0;
    },

    /** How many calls remain today. Never negative. */
    remaining(feature) {
      return Math.max(0, this.limit(feature) - this.used(feature));
    },

    /**
     * Try to consume 1 call for `feature`.
     * Returns { ok: true, remaining } on success,
     * or     { ok: false, reason: 'unknown-feature' | 'exhausted', remaining: 0 } on failure.
     *
     * This is the ONLY function that should mutate counters.
     */
    consume(feature) {
      if (!(feature in LIMITS)) {
        return { ok: false, reason: 'unknown-feature', remaining: 0 };
      }
      const state = readState();
      const used = state.counters[feature] || 0;
      if (used >= LIMITS[feature]) {
        return { ok: false, reason: 'exhausted', remaining: 0 };
      }
      state.counters[feature] = used + 1;
      writeState(state);
      _emitChange();
      return { ok: true, remaining: LIMITS[feature] - state.counters[feature] };
    },

    /**
     * Refund 1 call — call this from api.js when the network request fails,
     * so users don't lose quota to server-side errors.
     */
    refund(feature) {
      if (!(feature in LIMITS)) return;
      const state = readState();
      state.counters[feature] = Math.max(0, (state.counters[feature] || 0) - 1);
      writeState(state);
      _emitChange();
    },

    /** Manually wipe today's counters (used by the "Reset today's quota" button). */
    resetAll() {
      const state = { date: todayStr(), counters: {} };
      for (const key of Object.keys(LIMITS)) state.counters[key] = 0;
      writeState(state);
      _emitChange();
    },

    /** Snapshot of everything, for rendering the dashboard. */
    snapshot() {
      const s = readState();
      return Object.keys(LIMITS).map(key => ({
        key,
        label: LABELS[key],
        used:  s.counters[key] || 0,
        limit: LIMITS[key],
        remaining: Math.max(0, LIMITS[key] - (s.counters[key] || 0)),
        date: s.date
      }));
    },

    /** Subscribe to quota changes. Returns an unsubscribe function. */
    onChange(fn) {
      _listeners.add(fn);
      return () => _listeners.delete(fn);
    }
  };

  // ---- Event bus (tiny, no deps) ------------------------------------------
  const _listeners = new Set();
  function _emitChange() {
    for (const fn of _listeners) {
      try { fn(Quota.snapshot()); } catch (e) { console.error('[quota] listener', e); }
    }
  }

  // Expose globally. In v1 we use plain <script> tags (no modules) to keep
  // deploy on Vercel dead-simple.
  global.Quota = Quota;

})(window);
    
