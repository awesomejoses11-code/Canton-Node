/* =========================================================================
 * js/skill-loader.js
 *
 * Loads skills.json → fetches each SKILL.md → parses YAML frontmatter + body.
 * Exposes a simple global API:
 *
 *   Skills.list()          → array of all loaded skills
 *   Skills.get(id)         → one skill by id (or null)
 *   Skills.ready           → Promise that resolves when loading is finished
 *   Skills.reload()        → force re-fetch (useful during development)
 *
 * Design goals:
 *   - Pure Vanilla JS, no build step
 *   - Works with the existing Canton Node architecture
 *   - Failures are isolated (one broken skill does not kill the others)
 *   - Frontmatter is kept minimal and Senpi-compatible
 * ========================================================================= */

(function (global) {
  'use strict';

  const SKILLS_INDEX = 'skills.json';
  const CACHE_BUSTER = true;          // set false in production if you want caching

  // Internal state
  let _skills = [];                   // array of parsed skill objects
  let _byId   = Object.create(null);  // id → skill
  let _ready  = null;                 // Promise

  /* -----------------------------------------------------------------------
   * Tiny YAML frontmatter parser
   * Only handles the simple key: value and key: [list] forms we actually use.
   * ----------------------------------------------------------------------- */
  function parseFrontmatter(raw) {
    const result = { meta: {}, body: raw };

    if (!raw.startsWith('---')) return result;

    const end = raw.indexOf('---', 3);
    if (end === -1) return result;

    const yamlBlock = raw.slice(3, end).trim();
    const body = raw.slice(end + 3).trim();

    const meta = {};
    let currentKey = null;

    yamlBlock.split('\n').forEach(line => {
      line = line.replace(/\t/g, '  '); // normalise tabs

      // list item
      if (/^\s+-\s+/.test(line) && currentKey) {
        if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
        meta[currentKey].push(line.replace(/^\s+-\s+/, '').trim());
        return;
      }

      // key: value
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (m) {
        currentKey = m[1];
        let val = m[2].trim();

        if (val === '') {
          meta[currentKey] = [];          // will be filled by subsequent list items
        } else if (val.startsWith('[') && val.endsWith(']')) {
          // inline list: [a, b, c]
          meta[currentKey] = val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
        } else {
          // plain string / number
          meta[currentKey] = val.replace(/^["']|["']$/g, '');
        }
      }
    });

    result.meta = meta;
    result.body = body;
    return result;
  }

  /* -----------------------------------------------------------------------
   * Load a single skill file
   * ----------------------------------------------------------------------- */
  async function loadOne(entry) {
    const url = entry.path + (CACHE_BUSTER ? '?t=' + Date.now() : '');

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch \( {entry.path} ( \){res.status})`);
    }

    const raw = await res.text();
    const { meta, body } = parseFrontmatter(raw);

    // Required fields with sane fallbacks
    const skill = {
      id:          entry.id || meta.name || entry.path,
      name:        meta.name || entry.id,
      title:       meta.title || meta.name || entry.id,
      description: meta.description || '',
      version:     meta.version || '1.0.0',
      feature:     meta.feature || entry.id,          // quota bucket
      endpoints:   Array.isArray(meta.endpoints) ? meta.endpoints : [],
 dualKeywords: Array.isArray(meta.keywords)  ? meta.keywords  : [],
      body:        body,
      path:        entry.path,
      raw:         raw
    };

    // Alias for convenience
    skill.keywords = skill.dualKeywords;
    delete skill.dualKeywords;

    return skill;
  }

  /* -----------------------------------------------------------------------
   * Public API
   * ----------------------------------------------------------------------- */
  const Skills = {
    /** Promise that resolves when the initial load finishes */
    get ready() {
      if (!_ready) _ready = this.reload();
      return _ready;
    },

    /** Force re-load of skills.json + all SKILL.md files */
    async reload() {
      _skills = [];
      _byId   = Object.create(null);

      try {
        const indexRes = await fetch(SKILLS_INDEX + (CACHE_BUSTER ? '?t=' + Date.now() : ''));
        if (!indexRes.ok) throw new Error('Could not load skills.json');

        const index = await indexRes.json();
        const entries = Array.isArray(index.skills) ? index.skills : [];

        const results = await Promise.allSettled(entries.map(loadOne));

        results.forEach((r, i) => {
          if (r.status === 'fulfilled') {
            const skill = r.value;
            _skills.push(skill);
            _byId[skill.id] = skill;
          } else {
            console.warn('[Skills] Failed to load', entries[i].path, r.reason);
          }
        });

        console.info(`[Skills] Loaded ${_skills.length} skill(s)`);
      } catch (err) {
        console.error('[Skills] Fatal error while loading', err);
      }

      return _skills;
    },

    /** Return a shallow copy of all loaded skills */
    list() {
      return _skills.slice();
    },

    /** Get one skill by id */
    get(id) {
      return _byId[id] || null;
    },

    /** Simple keyword search (used by Master Agent later) */
    findByKeyword(text) {
      if (!text) return [];
      const q = text.toLowerCase();
      return _skills.filter(s =>
        s.keywords.some(k => q.includes(k.toLowerCase())) ||
        s.title.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
      );
    }
  };

  // Kick off loading as soon as the script is evaluated
  Skills.ready;

  // Expose globally
  global.Skills = Skills;

})(window);
