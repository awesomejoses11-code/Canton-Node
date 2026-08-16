/* =========================================================================
 * hub.js — Renders the quota dashboard on the Limits tab.
 * ========================================================================= */

(function () {
  'use strict';

  function renderQuota() {
    const grid = document.getElementById('quota-grid');
    const dateEl = document.getElementById('quota-date');
    if (!grid) return;

    const snap = window.Quota.snapshot();
    if (snap[0] && dateEl) dateEl.textContent = 'Refreshes at midnight · ' + snap[0].date;

    grid.innerHTML = snap.map(row => {
      if (row.unlimited || row.limit == null) {
        return `
        <div class="rounded-xl border border-slate-200 dark:border-slate-700 p-3 bg-slate-50/40 dark:bg-slate-900/40">
          <div class="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>${escapeHtml(row.label)}</span>
            <span><b class="text-slate-700 dark:text-slate-200">${row.used}</b> · Unlimited</span>
          </div>
          <div class="mt-2 h-1.5 w-full bg-slate-200 dark:bg-slate-700 rounded overflow-hidden">
            <div class="quota-bar h-full bg-emerald-500" style="width:4%"></div>
          </div>
        </div>`;
      }
      const pct = row.limit ? Math.min(100, (row.used / row.limit) * 100) : 0;
      const barColor = row.remaining === 0
        ? 'bg-rose-500'
        : row.remaining <= Math.ceil(row.limit * 0.2) ? 'bg-amber-500' : 'bg-emerald-500';
      return `
        <div class="rounded-xl border border-slate-200 dark:border-slate-700 p-3 bg-slate-50/40 dark:bg-slate-900/40">
          <div class="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>${escapeHtml(row.label)}</span>
            <span><b class="text-slate-700 dark:text-slate-200">${row.used}</b> / ${row.limit}</span>
          </div>
          <div class="mt-2 h-1.5 w-full bg-slate-200 dark:bg-slate-700 rounded overflow-hidden">
            <div class="quota-bar h-full ${barColor}" style="width:${pct}%"></div>
          </div>
        </div>`;
    }).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
      '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;'
    }[ch]));
  }

  window.PlatformUI = {
    registerTool() {},
    escapeHtml
  };

  window.Hub = {
    refresh() { renderQuota(); },
    openTool() {},
    closeWorkspace() {}
  };

  document.addEventListener('DOMContentLoaded', () => {
    renderQuota();
    if (window.Quota && window.Quota.onChange) {
      window.Quota.onChange(() => { renderQuota(); });
    }
  });

})();


(function (global) {
  'use strict';
  function wire() {
    if (!global.PrexzyAPI) return;
    var PrexzyError = global.PrexzyAPI.PrexzyError;

    if (!global.PrexzyAPI.generateImage) {
      global.PrexzyAPI.generateImage = async function (params, opts) {
        opts = opts || {};
        var prompt = (params && params.prompt) || '';
        if (!prompt) throw new PrexzyError('unknown', 'Missing prompt for image');
        var c = global.Quota.consume('image');
        if (!c.ok) {
          throw new PrexzyError('quota', 'Daily limit reached for "image". Try again tomorrow.', { feature: 'image' });
        }
        var loading = null;
        if (opts.loadingEl && global.PrexzyAPI.showLoading) {
          loading = global.PrexzyAPI.showLoading(opts.loadingEl, 'Generating image…');
        }
        var refunded = false;
        function refundOnce() {
          if (!refunded) { global.Quota.refund('image'); refunded = true; }
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
      };
    }

    if (global.PrexzyAPI.callResilient && !global.PrexzyAPI._mediaWire) {
      global.PrexzyAPI._mediaWire = true;
      var orig = global.PrexzyAPI.callResilient.bind(global.PrexzyAPI);
      global.PrexzyAPI.callResilient = async function (key, params, opts) {
        var k = key ? String(key) : '';
        if (k.indexOf('image.') === 0 && global.PrexzyAPI.generateImage) {
          return global.PrexzyAPI.generateImage(params || {}, opts || {});
        }
        if (k.indexOf('video.') === 0 && global.PrexzyAPI.generateVideo) {
          return global.PrexzyAPI.generateVideo(params || {}, opts || {});
        }
        return orig(key, params, opts);
      };
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})(window);

(function () {
  if (!document.querySelector('link[rel="icon"]')) {
    var head = document.head;
    function add(tag, attrs) {
      var el = document.createElement(tag);
      Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
      head.appendChild(el);
    }
    add('link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' });
    add('link', { rel: 'apple-touch-icon', href: '/favicon.svg' });
    add('meta', { property: 'og:title', content: 'Canton Node' });
    add('meta', { property: 'og:description', content: 'Private multi-tool generative hub' });
    add('meta', { property: 'og:image', content: 'https://canton-node.vercel.app/og-image.png' });
    add('meta', { name: 'twitter:card', content: 'summary_large_image' });
    add('meta', { name: 'twitter:image', content: 'https://canton-node.vercel.app/og-image.png' });
  }

  // Table-safe markdown: keep comparison tables inside the chat bubble
  if (!document.querySelector('script[data-cn="md-tables"]')) {
    var s = document.createElement('script');
    s.src = '/js/md-tables.js';
    s.defer = true;
    s.setAttribute('data-cn', 'md-tables');
    document.head.appendChild(s);
  }
})();
