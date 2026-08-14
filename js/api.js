/* =========================================================================
 * api.js — Central Prexzy API wrapper (restored from PLACEHOLDER)
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
      } }
  };

  const ALIASES = {
    'image.txt2img':  ['image.txt2img', 'image.genimage', 'image.aiwriter', 'image.dalle'],
    'image.genimage': ['image.genimage', 'image.txt2img', 'image.aiwriter', 'image.dalle'],
    'image.aiwriter': ['image.aiwriter', 'image.txt2img', 'image.genimage', 'image.dalle'],
    'image.dalle':    ['image.dalle', 'image.txt2img', 'image.genimage', 'image.aiwriter']
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
        res = await fetch(built.url, { method: endpoint.method || 'GET', signal: opts.signal });
      } catch (e) {
        if (endpoint.feature && global.Quota) global.Quota.refund(endpoint.feature);
        throw new PrexzyError('network', e.message || 'Network error');
      }
      if (!res.ok) {
        if (endpoint.feature && global.Quota) global.Quota.refund(endpoint.feature);
        throw new PrexzyError('http', 'HTTP ' + res.status, { status: res.status });
      }
      var data = await res.json().catch(function () { return {}; });
      return data;
    },
    callResilient: async function (key, params, opts) {
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
      throw lastErr || new PrexzyError('unknown', 'No endpoint available for: ' + key);
    },
    generateImage: async function (params, opts) {
      opts = opts || {};
      var prompt = (params && params.prompt) || '';
      if (!prompt) throw new PrexzyError('unknown', 'Missing prompt for image');
      if (global.Quota) {
        var c = global.Quota.consume('image');
        if (!c.ok) throw new PrexzyError('quota', 'Daily limit reached for "image".', { feature: 'image' });
      }
      var loading = opts.loadingEl ? showLoading(opts.loadingEl, 'Generating image…') : null;
      var refunded = false;
      function refundOnce() {
        if (!refunded && global.Quota) { global.Quota.refund('image'); refunded = true; }
      }
      try {
        if (loading) loading.setMessage('Trying Hugging Face FLUX → Prexzy…');
        var res = await fetch('/api/image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: prompt, size: params.size || undefined }),
          signal: opts.signal
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          refundOnce();
          throw new PrexzyError('http', data.error || ('HTTP ' + res.status), { status: res.status });
        }
        if (loading) loading.clear();
        if (data.url && !data.image_url) data.image_url = data.url;
        return data;
      } catch (e) {
        refundOnce();
        if (loading) loading.clear();
        if (e instanceof PrexzyError) throw e;
        throw new PrexzyError('network', e.message || 'Image request failed');
      }
    },
    generateVideo: async function (params, opts) {
      opts = opts || {};
      var prompt = (params && params.prompt) || '';
      if (!prompt) throw new PrexzyError('unknown', 'Missing prompt for video');
      if (global.Quota) {
        var c = global.Quota.consume('video');
        if (!c.ok) throw new PrexzyError('quota', 'Daily limit reached for "video".', { feature: 'video' });
      }
      var loading = opts.loadingEl ? showLoading(opts.loadingEl, 'Generating video… this can take 30–90 s') : null;
      var refunded = false;
      function refundOnce() {
        if (!refunded && global.Quota) { global.Quota.refund('video'); refunded = true; }
      }
      try {
        if (loading) loading.setMessage('Trying Pixazo → Pyramid Flow → Prexzy…');
        var res = await fetch('/api/video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: prompt,
            duration: params.duration || 5,
            resolution: params.resolution || '720p',
            imageUrl: params.image || params.imageUrl || null,
            poll: opts.poll !== false
          }),
          signal: opts.signal
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          refundOnce();
          throw new PrexzyError('http', data.error || ('HTTP ' + res.status), { status: res.status });
        }
        if (data.task_id && !data.url && opts.poll !== false) {
          if (loading) loading.setMessage('Waiting for Pixazo…');
          var finalUrl = await pollPixazoClient(data.task_id, {
            onProgress: function (s) { if (loading) loading.setMessage('Status: ' + s + '…'); },
            signal: opts.signal
          });
          if (loading) loading.clear();
          return { url: finalUrl, source: data.source || 'pixazo-ltx', task_id: data.task_id };
        }
        if (loading) loading.clear();
        if (data.url && !data.video_url) data.video_url = data.url;
        return data;
      } catch (e) {
        refundOnce();
        if (loading) loading.clear();
        if (e instanceof PrexzyError) throw e;
        throw new PrexzyError('network', e.message || 'Video request failed');
      }
    }
  };

  async function pollPixazoClient(taskId, opts) {
    opts = opts || {};
    var intervalMs = opts.intervalMs || 5000;
    var timeoutMs = opts.timeoutMs || 4 * 60 * 1000;
    var started = Date.now();
    while (true) {
      if (opts.signal && opts.signal.aborted) throw new PrexzyError('network', 'Polling aborted');
      var res = await fetch('/api/video-status?task_id=' + encodeURIComponent(taskId), { signal: opts.signal });
      if (!res.ok) {
        var t = await res.text();
        throw new PrexzyError('http', 'Status ' + res.status + ': ' + t.slice(0, 120));
      }
      var data = await res.json();
      var status = String(data.status || '').toUpperCase();
      if (opts.onProgress) opts.onProgress(status);
      if (status === 'COMPLETED') {
        var media = data.output && data.output.media_url;
        var url = Array.isArray(media) ? media[0] : media;
        if (!url) throw new PrexzyError('parse', 'Completed but no media_url');
        return url;
      }
      if (status === 'FAILED' || status === 'ERROR') {
        throw new PrexzyError('http', data.error || ('Pixazo ' + status));
      }
      if (Date.now() - started > timeoutMs) {
        throw new PrexzyError('unknown', 'Video generation timed out');
      }
      await new Promise(function (r) { setTimeout(r, intervalMs); });
    }
  }

  global.PrexzyAPI = PrexzyAPI;
})(window);
