/* =========================================================================
 * api.js — Central Prexzy API wrapper
 *
 * Rules for the rest of the codebase:
 *   • Specialist agents NEVER call fetch(prexzyapis.com/...) directly.
 *   • They ALWAYS go through PrexzyAPI.call(...) so that:
 *       1. Daily quota is enforced (via Quota.consume).
 *       2. Failed requests refund the quota (via Quota.refund).
 *       3. Errors are shaped uniformly.
 *       4. We have one obvious place to patch payload shapes when a
 *          Prexzy endpoint changes.
 *
 * Endpoint catalog is data-driven: see ENDPOINTS below and tools.json.
 * Only high-utility endpoints are wired up — per the spec, we do NOT try
 * to support all 466.
 * ========================================================================= */

(function (global) {
  'use strict';

  // Prexzy public base URL. If we ever need a proxy (e.g. a Vercel serverless
  // function for CORS or key hiding), we swap this to `/api/prexzy` and add
  // a tiny function under /api. For v1 we call the public API directly.
  const BASE_URL = 'https://prexzyapis.com';

  // ---- Endpoint catalog ----------------------------------------------------
  //
  // Each entry describes ONE Prexzy endpoint we actually use:
  //   path       — path segment appended to BASE_URL
  //   method     — 'GET' or 'POST'
  //   feature    — quota bucket key (must exist in quota.js LIMITS)
  //   build(p)   — takes the caller's params object and returns
  //                { url, init } for fetch()
  //
  // We keep `build` per-endpoint so different Prexzy conventions (query
  // string vs JSON body vs form data) stay isolated and easy to fix.
  const ENDPOINTS = {

    // ---------------- Text / chat -----------------------------------------
    // Chatex fronts GPT-5.4 — the most capable chat model on Prexzy.
    // It is the Master Agent's router model (consumed under the `master`
    // quota bucket there) and is also available to the chat/web agents.
    'chat.chatex': {
      path: '/ai/chatex',
      method: 'GET',
      feature: 'text',
      build: (p) => ({
        url: qs('/ai/chatex', {
          q: p.prompt,
          model: p.model || undefined,
          websearch: p.web ? 'true' : undefined
        }),
        init: { method: 'GET' }
      })
    },
    'chat.askgpt5': {
      path: '/ai/askgpt5',
      method: 'GET',
      feature: 'text',
      build: (p) => ({
        url: qs('/ai/askgpt5', {
          q: p.prompt,
          model: p.model || undefined,
          websearch: p.web ? 'true' : undefined
        }),
        init: { method: 'GET' }
      })
    },
    'chat.mistral': {
      path: '/ai/mistral',
      method: 'GET',
      feature: 'text',
      build: (p) => ({
        url: qs('/ai/mistral', { q: p.prompt, websearch: p.web ? 'true' : undefined }),
        init: { method: 'GET' }
      })
    },
    'chat.writer': {
      path: '/ai/aiwriter-chat',
      method: 'GET',
      feature: 'text',
      build: (p) => ({
        url: qs('/ai/aiwriter-chat', { q: p.prompt, model: p.model || undefined }),
        init: { method: 'GET' }
      })
    },
    'chat.summarize': {
      path: '/ai/summarize',
      method: 'GET',
      feature: 'text',
      build: (p) => ({ url: qs('/ai/summarize', { text: p.text }), init: { method: 'GET' } })
    },

    // ---------------- Image generation ------------------------------------
    'image.txt2img': {
      path: '/ai/txt2img',
      method: 'GET',
      feature: 'image',
      build: (p) => ({
        url: qs('/ai/txt2img', { prompt: p.prompt }),
        init: { method: 'GET' }
      })
    },
    'image.genimage': {
      path: '/ai/genimage',
      method: 'GET',
      feature: 'image',
      build: (p) => ({
        url: qs('/ai/genimage', {
          prompt: p.prompt,
          size:   p.size  || undefined,
          steps:  p.steps || undefined
        }),
        init: { method: 'GET' }
      })
    },
    'image.aiwriter': {
      path: '/ai/aiwriter-image',
      method: 'GET',
      feature: 'image',
      build: (p) => ({
        url: qs('/ai/aiwriter-image', { prompt: p.prompt, size: p.size || '1024x1024' }),
        init: { method: 'GET' }
      })
    },
    'image.dalle': {
      path: '/ai/dalle',
      method: 'GET',
      feature: 'image',
      build: (p) => ({ url: qs('/ai/dalle', { prompt: p.prompt }), init: { method: 'GET' } })
    },

    // ---------------- Music -----------------------------------------------
    // Two flavors: aimelody is one-shot, text2music is async (create+status).
    'music.aimelody': {
      path: '/ai/aimelody',
      method: 'GET',
      feature: 'music',
      build: (p) => ({
        url: qs('/ai/aimelody', { prompt: p.prompt }),
        init: { method: 'GET' }
      })
    },
    'music.text2music.create': {
      path: '/ai/text2music-create',
      method: 'GET',
      feature: 'music',
      build: (p) => ({
        url: qs('/ai/text2music-create', {
          lyrics: p.lyrics,
          title:  p.title  || undefined,
          style:  p.style  || undefined
        }),
        init: { method: 'GET' }
      })
    },
    'music.text2music.status': {
      // Polling doesn't consume quota — the "create" call already did.
      path: '/ai/text2music-status',
      method: 'GET',
      feature: null,
      build: (p) => ({
        url: qs('/ai/text2music-status', { task_id: p.task_id }),
        init: { method: 'GET' }
      })
    },

    // ---------------- Video -----------------------------------------------
    'video.create': {
      path: '/ai/aiart-video',
      method: 'GET',
      feature: 'video',
      build: (p) => ({
        url: qs('/ai/aiart-video', {
          prompt: p.prompt,
          image:  p.image  || undefined,
          style:  p.style  || undefined
        }),
        init: { method: 'GET' }
      })
    },
    'video.status': {
      path: '/ai/aiart-video-status',
      method: 'GET',
      feature: null, // polling — quota already consumed on create
      build: (p) => ({
        url: qs('/ai/aiart-video-status', { task_id: p.task_id }),
        init: { method: 'GET' }
      })
    },

    // ---------------- HTML ↔ Image ----------------------------------------
    'html2image.direct': {
      path: '/tools/html2imgdirect',
      method: 'POST',
      feature: 'html2image',
      build: (p) => ({
        url: BASE_URL + '/tools/html2imgdirect',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html: p.html, width: p.width, height: p.height })
        }
      })
    },
    'html2image.json': {
      path: '/tools/html2img',
      method: 'POST',
      feature: 'html2image',
      build: (p) => ({
        url: BASE_URL + '/tools/html2img',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html: p.html, width: p.width, height: p.height })
        }
      })
    },

    // ---------------- TTS -------------------------------------------------
    // Prexzy has several TTS-adjacent endpoints. We keep a stable key and
    // let the actual endpoint be swapped once we've picked the best one
    // during private testing.
    'tts.default': {
      // Real Prexzy TTS family: /tts/<voice>. Voice comes from the caller,
      // falling back to the user's saved default (Settings) then 'olivia'.
      path: '/tts/olivia', // resolved dynamically in build()
      method: 'GET',
      feature: 'tts',
      build: (p) => {
        const voice = String(
          p.voice ||
          (global.Settings ? Settings.load((global.Auth && Auth.current() || {}).email).ttsVoice : '') ||
          'olivia'
        ).toLowerCase();
        return {
          url: qs('/tts/' + encodeURIComponent(voice), { text: p.text }),
          init: { method: 'GET' }
        };
      }
    },

    // ---------------- Code compile / convert ------------------------------
    'code.compile.python':  compileEndpoint('/tools/compilepython'),
    'code.compile.js':      compileEndpoint('/tools/compilejs'),
    'code.compile.java':    compileEndpoint('/tools/compilejava'),
    'code.compile.c':       compileEndpoint('/tools/compilec'),
    'code.compile.cpp':     compileEndpoint('/tools/compilecpp'),
    'code.compile.csharp':  compileEndpoint('/tools/compilecsharp'),

    'code.convert.python': convertEndpoint('/tools/topython'),
    'code.convert.js':     convertEndpoint('/tools/tojavascript'),
    'code.convert.java':   convertEndpoint('/tools/tojava'),
    'code.convert.cpp':    convertEndpoint('/tools/tocpp'),
    'code.convert.php':    convertEndpoint('/tools/tophp')
  };

  // ---- Fallback chains ------------------------------------------------
  //
  // Endpoints that are functionally interchangeable — same feature bucket,
  // same param shape. If the caller's chosen one fails with a retryable
  // error, PrexzyAPI.callResilient() tries the next one automatically
  // instead of surfacing the failure (e.g. the 400s from /ai/askgpt5).
  const FALLBACK_CHAINS = {
    'chat.chatex':    ['chat.chatex', 'chat.askgpt5', 'chat.mistral', 'chat.writer'],
    'chat.askgpt5':   ['chat.askgpt5', 'chat.chatex', 'chat.mistral', 'chat.writer'],
    'chat.mistral':   ['chat.mistral', 'chat.chatex', 'chat.askgpt5', 'chat.writer'],
    'chat.writer':    ['chat.writer', 'chat.chatex', 'chat.askgpt5', 'chat.mistral'],
    'image.txt2img':  ['image.txt2img', 'image.genimage', 'image.aiwriter', 'image.dalle'],
    'image.genimage': ['image.genimage', 'image.txt2img', 'image.aiwriter', 'image.dalle'],
    'image.aiwriter': ['image.aiwriter', 'image.txt2img', 'image.genimage', 'image.dalle'],
    'image.dalle':    ['image.dalle', 'image.txt2img', 'image.genimage', 'image.aiwriter']
  };

  // --- Helpers to build repetitive endpoint entries ------------------------
  function compileEndpoint(path) {
    return {
      path,
      method: 'POST',
      feature: 'code',
      build: (p) => ({
        url: BASE_URL + path,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: p.code, stdin: p.stdin || '' })
        }
      })
    };
  }
  function convertEndpoint(path) {
    return {
      path,
      method: 'POST',
      feature: 'code',
      build: (p) => ({
        url: BASE_URL + path,
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: p.code, from: p.from || 'auto' })
        }
      })
    };
  }

  // --- URL / query string helper ------------------------------------------
  function qs(path, params) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue;
      usp.append(k, String(v));
    }
    const query = usp.toString();
    return BASE_URL + path + (query ? ('?' + query) : '');
  }

  // ---- Uniform error shape -----------------------------------------------
  class PrexzyError extends Error {
    constructor(kind, message, extra) {
      super(message);
      this.kind = kind;         // 'quota' | 'network' | 'http' | 'parse' | 'unknown'
      this.extra = extra || null;
    }
  }

  // ---- The public wrapper -------------------------------------------------
  const PrexzyAPI = {

    /** List every wired-up endpoint key. */
    endpoints() { return Object.keys(ENDPOINTS); },

    /** Introspect one endpoint definition (path, method, feature). */
    describe(key) {
      const e = ENDPOINTS[key];
      if (!e) return null;
      return { key, path: e.path, method: e.method, feature: e.feature };
    },

    /**
     * Call a Prexzy endpoint by key.
     *
     *   const data = await PrexzyAPI.call('image.txt2img', { prompt: 'a cat' });
     *
     * Options:
     *   { signal }  — an AbortSignal to cancel the request.
     *   { raw:true } — return the raw Response instead of parsed JSON/text
     *                  (useful for endpoints that return binary images).
     */
    async call(key, params, opts) {
      const endpoint = ENDPOINTS[key];
      if (!endpoint) {
        throw new PrexzyError('unknown', `Unknown endpoint key: ${key}`);
      }
      opts = opts || {};

      // 1) Quota check (skip if this endpoint doesn't consume quota,
      //    e.g. status polling).
      if (endpoint.feature) {
        const c = global.Quota.consume(endpoint.feature);
        if (!c.ok) {
          throw new PrexzyError('quota',
            `Daily limit reached for "${endpoint.feature}". Try again tomorrow.`,
            { feature: endpoint.feature });
        }
      }

      // 2) Build the request.
      let req;
      try {
        req = endpoint.build(params || {});
      } catch (e) {
        if (endpoint.feature) global.Quota.refund(endpoint.feature);
        throw new PrexzyError('unknown', 'Failed to build request: ' + e.message);
      }

      // 3) Fire it.
      let resp;
      try {
        resp = await fetch(req.url, Object.assign({}, req.init, { signal: opts.signal }));
      } catch (e) {
        if (endpoint.feature) global.Quota.refund(endpoint.feature);
        throw new PrexzyError('network', 'Network error: ' + e.message);
      }

      if (!resp.ok) {
        if (endpoint.feature) global.Quota.refund(endpoint.feature);
        const bodyText = await safeText(resp);
        throw new PrexzyError('http',
          `HTTP ${resp.status} from ${endpoint.path}`,
          { status: resp.status, body: bodyText });
      }

      if (opts.raw) return resp;

      // 4) Parse — Prexzy endpoints mostly return JSON but some tools return
      //    plain text or image binaries. Best-effort parse.
      const ctype = (resp.headers.get('content-type') || '').toLowerCase();
      try {
        if (ctype.includes('application/json')) return await resp.json();
        if (ctype.startsWith('image/') || ctype.startsWith('audio/') || ctype.startsWith('video/')) {
          const blob = await resp.blob();
          return { _binary: true, blob, contentType: ctype, url: URL.createObjectURL(blob) };
        }
        // Fallback: text (some endpoints return JSON without the header).
        const txt = await resp.text();
        try { return JSON.parse(txt); } catch (_) { return { _text: true, text: txt }; }
      } catch (e) {
        throw new PrexzyError('parse', 'Failed to parse response: ' + e.message);
      }
    },

    /** Poll an async endpoint until it reports "done" or times out.
     *  `isDone(data)` returns true when the polled response indicates completion.
     *  Returns the final response payload. */
    async poll(key, params, isDone, opts) {
      opts = opts || {};
      const interval = opts.intervalMs || 3000;
      const timeout  = opts.timeoutMs  || 5 * 60 * 1000; // 5 min default
      const started  = Date.now();

      while (true) {
        const data = await PrexzyAPI.call(key, params, { signal: opts.signal });
        if (isDone(data)) return data;
        if (Date.now() - started > timeout) {
          throw new PrexzyError('unknown', 'Polling timed out for ' + key);
        }
        await new Promise(r => setTimeout(r, interval));
      }
    },

    /**
     * Like call(), but if `key` has known interchangeable alternatives
     * (see FALLBACK_CHAINS) and the request fails with a retryable error
     * — http, network, or parse — it tries the next one in the chain
     * instead of surfacing the failure. A 'quota' error aborts immediately:
     * chain members share the same quota bucket, so retrying would just
     * fail the same way.
     *
     * On total failure, throws the last error with `.extra.attempts`
     * listing every endpoint key tried and why each one failed.
     */
    async callResilient(key, params, opts) {
      const chain = FALLBACK_CHAINS[key] || [key];
      const attempts = [];
      let lastErr = null;

      for (const candidate of chain) {
        try {
          return await PrexzyAPI.call(candidate, params, opts);
        } catch (e) {
          attempts.push({ key: candidate, kind: e.kind, message: e.message });
          lastErr = e;
          if (e.kind === 'quota') break;
        }
      }

      if (lastErr) lastErr.extra = Object.assign({}, lastErr.extra, { attempts });
      throw lastErr || new PrexzyError('unknown', `No endpoint available for: ${key}`);
    },

    PrexzyError
  };

  async function safeText(resp) {
    try { return await resp.text(); } catch (_) { return ''; }
  }

  // Expose globally.
  global.PrexzyAPI = PrexzyAPI;

})(window);
