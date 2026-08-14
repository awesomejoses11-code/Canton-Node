/* =========================================================================
 * api.js — Central Prexzy API wrapper + media helpers
 * ========================================================================= */
(function (global) {
  'use strict';

  const BASE_URL = 'https://prexzyapis.com';

  class PrexzyError extends Error {
    constructor(kind, message, extra) {
      super(message);
      this.name = 'PrexzyError';
      this.kind = kind;
      if (extra) Object.assign(this, extra);
    }
  }

  function showLoading(el, initialMessage) {
    if (!el) return { setMessage: function () {}, clear: function () {} };
    el.classList.remove('hidden');
    el.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 py-2';
    const spin = document.createElement('span');
    spin.className = 'inline-block w-3.5 h-3.5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin';
    const msg = document.createElement('span');
    msg.textContent = initialMessage || 'Working…';
    row.append(spin, msg);
    el.appendChild(row);
    return {
      setMessage: function (t) { msg.textContent = t; },
      clear: function () { el.innerHTML = ''; }
    };
  }

  const ENDPOINTS = {
    'image.txt2img':  { path: '/ai/txt2img', method: 'GET', feature: 'image',
      build: function (p) { return { url: BASE_URL + '/ai/txt2img?prompt=' + encodeURIComponent(p.prompt || '') }; } },
    'image.genimage': { path: '/ai/genimage', method: 'GET', feature: 'image',
      build: function (p) {
        var u = BASE_URL + '/ai/genimage?prompt=' + encodeURIComponent(p.prompt || '');
        if (p.size) u += '&size=' + encodeURIComponent(p.size);
        return { url: u };
      } },
    'image.dalle': { path: '/ai/dalle', method: 'GET', feature: 'image',
      build: function (p) { return { url: BASE_URL + '/ai/dalle?prompt=' + encodeURIComponent(p.prompt || '') }; } },
    'image.aiwriter': { path: '/ai/aiwriter-image', method: 'GET', feature: 'image',
      build: function (p) { return { url: BASE_URL + '/ai/aiwriter-image?prompt=' + encodeURIComponent(p.prompt || '') }; } },
    'video.create': { path: '/ai/aiart-video', method: 'GET', feature: 'video',
      build: function (p) {
        var u = BASE_URL + '/ai/aiart-video?prompt=' + encodeURIComponent(p.prompt || '');
        if (p.image) u += '&image=' + encodeURIComponent(p.image);
        return { url: u };
      } },
    'music.aimelody': { path: '/ai/aimelody', method: 'GET', feature: 'music',
      build: function (p) {
        return { url: BASE_URL + '/ai/aimelody?prompt=' + encodeURIComponent(p.prompt || p.text || '') };
      } },
    'music.text2music.create': { path: '/ai/text2music', method: 'GET', feature: 'music',
      build: function (p) {
        return { url: BASE_URL + '/ai/text2music?prompt=' + encodeURIComponent(p.prompt || p.lyrics || '') };
      } },
    'tts.default': { path: '/ai/tts', method: 'GET', feature: 'tts',
      build: function (p) {
        var u = BASE_URL + '/ai/tts?text=' + encodeURIComponent(p.text || p.prompt || '');
        if (p.voice) u += '&voice=' + encodeURIComponent(p.voice);
        return { url: u };
      } }
  };

  const ALIASES = {
    'image.txt2img':  ['image.txt2img', 'image.genimage', 'image.aiwriter', 'image.dalle'],
    'image.genimage': ['image.genimage', 'image.txt2img', 'image.aiwriter', 'image.dalle'],
    'image.aiwriter': ['image.aiwriter', 'image.txt2img', 'image.genimage', 'image.dalle'],
    'image.dalle':    ['image.dalle', 'image.txt2img', 'image.genimage', 'image.aiwriter'],
    'music.aimelody': ['music.aimelody', 'music.text2music.create'],
    'music.text2music.create': ['music.text2music.create', 'music.aimelody']
  };

  const PrexzyAPI = {
    PrexzyError: PrexzyError,
    showLoading: showLoading,
    endpoints: function () { return Object.keys(ENDPOINTS); },
    describe: function (key) {
      var e = ENDPOINTS[key];
      if (!e) return null;
      return { key: key, path: e.path, method: e.method, feature: e.feature };
    },
    call: async function (key, params, opts) {
      opts = opts || {};
      var endpoint = ENDPOINTS[key];
      if (!endpoint) throw new PrexzyError('unknown', 'Unknown endpoint key: ' + key);
      if (endpoint.feature && global.Quota) {
        var c = global.Quota.consume(endpoint.feature);
        if (!c.ok) throw new PrexzyError('quota', 'Daily limit reached for "' + endpoint.feature + '".', { feature: endpoint.feature });
      }
      var built = endpoint.build(params || {});
      var res;
      try {
        res = await fetch(built.url, { method: endpoint.method || 'GET', signal: AbortSignal.timeout(60000) });
      } catch (e) {
        if (endpoint.feature && global.Quota) global.Quota.refund(endpoint.feature);
        throw new PrexzyError('network', e.message || 'Network error');
      }
      if (!res.ok) {
        if (endpoint.feature && global.Quota) global.Quota.refund(endpoint.feature);
        var errText = await res.text().catch(function () { return ''; });
        throw new PrexzyError('http', 'HTTP ' + res.status + (errText ? ': ' + errText.slice(0, 200) : ''));
      }
      var ctype = (res.headers.get('content-type') || '').toLowerCase();
      if (ctype.indexOf('application/json') >= 0) {
        return await res.json();
      }
      if (ctype.indexOf('audio/') === 0 || ctype.indexOf('image/') === 0 || ctype.indexOf('video/') === 0) {
        var blob = await res.blob();
        return { url: URL.createObjectURL(blob), _binary: true, contentType: ctype };
      }
      var text = await res.text();
      try { return JSON.parse(text); } catch (_) { return { _text: text }; }
    },
    callResilient: async function (key, params, opts) {
      opts = opts || {};
      var chain = ALIASES[key] || [key];
      var lastErr = null;
      for (var i = 0; i < chain.length; i++) {
        try {
          return await PrexzyAPI.call(chain[i], params, opts);
        } catch (e) {
          lastErr = e;
          if (e.kind === 'quota') throw e;
        }
      }
      throw lastErr || new PrexzyError('unknown', 'All endpoints failed for ' + key);
    },
    generateImage: async function (params, opts) {
      opts = opts || {};
      var loading = opts.loadingEl ? showLoading(opts.loadingEl, 'Generating image…') : null;
      try {
        if (global.Quota) {
          var c = global.Quota.consume('image');
          if (!c.ok) throw new PrexzyError('quota', 'Daily image limit reached.');
        }
        var res = await fetch('/api/image', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: (params && params.prompt) || '', size: (params && params.size) || undefined })
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          if (global.Quota) global.Quota.refund('image');
          throw new PrexzyError('http', data.error || ('Image HTTP ' + res.status));
        }
        return data;
      } catch (e) {
        if (e.kind !== 'quota' && global.Quota) { /* refund already handled on !ok */ }
        throw e;
      } finally {
        if (loading) loading.clear();
      }
    },
    generateVideo: async function (params, opts) {
      opts = opts || {};
      var loading = opts.loadingEl ? showLoading(opts.loadingEl, 'Generating video (this can take a minute)…') : null;
      try {
        if (global.Quota) {
          var c = global.Quota.consume('video');
          if (!c.ok) throw new PrexzyError('quota', 'Daily video limit reached.');
        }
        var res = await fetch('/api/video', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: (params && params.prompt) || '',
            duration: (params && params.duration) || 5,
            poll: opts.poll !== false
          })
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          if (global.Quota) global.Quota.refund('video');
          throw new PrexzyError('http', data.error || ('Video HTTP ' + res.status));
        }
        if (loading) loading.setMessage('Almost done…');
        return data;
      } catch (e) {
        throw e;
      } finally {
        if (loading) loading.clear();
      }
    }
  };

  global.PrexzyAPI = PrexzyAPI;
})(window);
