/* =========================================================================
 * hub.js — Renders the quota dashboard on the Limits tab.
 *
 * Specialist agent cards were removed from the Agents tab — Master Agent
 * routes automatically and quotas already appear under Limits.
 * ========================================================================= */

(function () {
  'use strict';

  // ---- Quota dashboard ----------------------------------------------------

  function renderQuota() {
    const grid = document.getElementById('quota-grid');
    const dateEl = document.getElementById('quota-date');
    if (!grid) return;

    const snap = window.Quota.snapshot();
    if (snap[0] && dateEl) dateEl.textContent = 'Refreshes at midnight · ' + snap[0].date;

    grid.innerHTML = snap.map(row => {
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
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  // Kept for compatibility with any remaining callers / future tools.
  window.PlatformUI = {
    registerTool() { /* no-op — specialist cards removed from homepage */ },
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


/* ---- Image generation (HF → Prexzy) + Execute path wiring ---- */
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

    // Route image.* Execute calls through generateImage
    if (global.PrexzyAPI.callResilient && !global.PrexzyAPI._imageWire) {
      global.PrexzyAPI._imageWire = true;
      var orig = global.PrexzyAPI.callResilient.bind(global.PrexzyAPI);
      global.PrexzyAPI.callResilient = async function (key, params, opts) {
        if (key && String(key).indexOf('image.') === 0) {
          return global.PrexzyAPI.generateImage(params || {}, opts || {});
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
