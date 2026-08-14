/* =========================================================================
 * js/master-thinking.js — collapsible Thinking panel + duration
 * ========================================================================= */
(function (global) {
  'use strict';

  var lastThinking = null;
  var lastDurationMs = null;
  var pendingStart = null;

  function formatDuration(ms) {
    if (ms == null || isNaN(ms)) return null;
    if (ms < 1000) return ms + ' ms';
    return (ms / 1000).toFixed(1) + ' s';
  }

  function renderThinkingBlock(thinking, durationMs) {
    if (!thinking) return null;
    var wrap = document.createElement('div');
    wrap.className = 'mb-2 rounded-xl border border-violet-200 dark:border-violet-900/50 bg-violet-50/80 dark:bg-violet-950/30 text-xs text-slate-700 dark:text-slate-200 overflow-hidden';
    wrap.setAttribute('data-master-thinking', '1');

    var summary = document.createElement('button');
    summary.type = 'button';
    summary.className = 'w-full flex items-center justify-between gap-2 px-3 py-2 text-left font-semibold text-violet-700 dark:text-violet-300 hover:bg-violet-100/50 dark:hover:bg-violet-900/30';
    var left = document.createElement('span');
    left.textContent = 'Thinking';
    var right = document.createElement('span');
    right.className = 'text-[10px] font-normal text-slate-500 dark:text-slate-400 font-mono';
    var dur = formatDuration(durationMs);
    right.textContent = (dur ? dur + ' · ' : '') + 'tap to expand';
    summary.append(left, right);

    var body = document.createElement('pre');
    body.className = 'hidden whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-slate-600 dark:text-slate-300 m-0 px-3 pb-2 border-t border-violet-100 dark:border-violet-900/40 pt-2';
    body.textContent = String(thinking);

    var open = false;
    summary.addEventListener('click', function () {
      open = !open;
      body.classList.toggle('hidden', !open);
      right.textContent = (dur ? dur + ' · ' : '') + (open ? 'tap to hide' : 'tap to expand');
    });

    wrap.append(summary, body);
    return wrap;
  }

  function injectThinkingIntoBubble(bubbleEl, thinking, durationMs) {
    if (!bubbleEl || !thinking) return;
    if (bubbleEl.querySelector('[data-master-thinking]')) return;
    var block = renderThinkingBlock(thinking, durationMs);
    if (!block) return;
    bubbleEl.insertBefore(block, bubbleEl.firstChild);
  }

  var origFetch = global.fetch;
  if (typeof origFetch === 'function') {
    global.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var isMaster = String(url).indexOf('/api/master') !== -1;
      if (isMaster) pendingStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      var p = origFetch.apply(this, arguments);
      if (!isMaster) return p;
      return p.then(function (res) {
        try {
          var end = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          lastDurationMs = pendingStart != null ? Math.round(end - pendingStart) : null;
          pendingStart = null;
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
        var t = (bubble.textContent || '').trim();
        if (!t || t === 'Routing your request…' || t === 'Loading tools…') continue;
        injectThinkingIntoBubble(bubble, lastThinking, lastDurationMs);
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
