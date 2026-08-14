/* =========================================================================
 * js/master-thinking.js — Phase A: show pre-execution plan in the thread
 *
 * Patches fetch so /api/master responses that include `thinking` get a
 * readable plan block prepended in the UI when the route card is rendered.
 * Additive only — does not replace master-client.js.
 * ========================================================================= */
(function (global) {
  'use strict';

  function renderThinkingBlock(thinking) {
    if (!thinking) return null;
    var wrap = document.createElement('div');
    wrap.className = 'mb-2 rounded-xl border border-violet-200 dark:border-violet-900/50 bg-violet-50/80 dark:bg-violet-950/30 px-3 py-2 text-xs text-slate-700 dark:text-slate-200';
    var title = document.createElement('div');
    title.className = 'font-semibold text-violet-700 dark:text-violet-300 mb-1';
    title.textContent = 'Thinking';
    var body = document.createElement('pre');
    body.className = 'whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-slate-600 dark:text-slate-300 m-0';
    body.textContent = String(thinking);
    wrap.append(title, body);
    return wrap;
  }

  /** Call after an assistant bubble is filled with a route / answer */
  function injectThinkingIntoBubble(bubbleEl, thinking) {
    if (!bubbleEl || !thinking) return;
    if (bubbleEl.querySelector('[data-master-thinking]')) return;
    var block = renderThinkingBlock(thinking);
    if (!block) return;
    block.setAttribute('data-master-thinking', '1');
    bubbleEl.insertBefore(block, bubbleEl.firstChild);
  }

  // Remember last thinking from /api/master for the client to pick up
  var lastThinking = null;

  var origFetch = global.fetch;
  if (typeof origFetch === 'function') {
    global.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var p = origFetch.apply(this, arguments);
      if (String(url).indexOf('/api/master') === -1) return p;
      return p.then(function (res) {
        try {
          var clone = res.clone();
          clone.json().then(function (data) {
            if (data && data.thinking) lastThinking = data.thinking;
            else lastThinking = null;
          }).catch(function () {});
        } catch (_) {}
        return res;
      });
    };
  }

  // After Master paints route cards, attach thinking if present
  var observer = new MutationObserver(function (mutations) {
    if (!lastThinking) return;
    for (var i = 0; i < mutations.length; i++) {
      var nodes = mutations[i].addedNodes;
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (!n || n.nodeType !== 1) continue;
        var bubble = n.classList && n.classList.contains('assistant-bubble')
          ? n
          : (n.querySelector && n.querySelector('.assistant-bubble'));
        if (!bubble) continue;
        // Skip pure loading states
        var t = (bubble.textContent || '').trim();
        if (!t || t === 'Routing your request…' || t === 'Loading tools…') continue;
        injectThinkingIntoBubble(bubble, lastThinking);
        lastThinking = null;
      }
    }
  });

  function start() {
    var thread = document.getElementById('master-thread');
    if (thread) observer.observe(thread, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  global.MasterThinking = {
    inject: injectThinkingIntoBubble,
    getLast: function () { return lastThinking; }
  };
})(window);
