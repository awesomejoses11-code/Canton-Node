/* js/md-tables.js — table-safe markdown rendering */
(function () {
  'use strict';

  function ensureMarkdownStyles() {
    if (document.getElementById('cn-md-table-css')) return;
    var s = document.createElement('style');
    s.id = 'cn-md-table-css';
    s.textContent = [
      '.assistant-bubble{min-width:0;max-width:100%;overflow:hidden;}',
      '.markdown-body{min-width:0;max-width:100%;overflow-wrap:anywhere;word-wrap:break-word;}',
      '.markdown-body .md-table-wrap{width:100%;max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0.55em 0;border-radius:0.5rem;border:1px solid rgb(226 232 240);background:rgb(248 250 252 / 0.6);}',
      '.dark .markdown-body .md-table-wrap{border-color:rgb(51 65 85);background:rgb(15 23 42 / 0.35);}',
      '.markdown-body table{width:100%;border-collapse:collapse;font-size:0.8em;line-height:1.35;table-layout:auto;}',
      '.markdown-body thead th{position:sticky;top:0;z-index:1;}',
      '.markdown-body th,.markdown-body td{padding:0.4em 0.55em;border:1px solid rgb(226 232 240);vertical-align:top;text-align:left;overflow-wrap:anywhere;word-break:break-word;hyphens:auto;}',
      '.dark .markdown-body th,.dark .markdown-body td{border-color:rgb(51 65 85);}',
      '.markdown-body th{font-weight:600;background:rgb(241 245 249);white-space:nowrap;}',
      '.dark .markdown-body th{background:rgb(30 41 59);}',
      '.markdown-body tr:nth-child(even) td{background:rgb(248 250 252 / 0.55);}',
      '.dark .markdown-body tr:nth-child(even) td{background:rgb(15 23 42 / 0.25);}',
      '.markdown-body pre{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;}',
      '.markdown-body img,.markdown-body video{max-width:100%;height:auto;}'
    ].join('');
    document.head.appendChild(s);
  }

  function wrapMarkdownTables(root) {
    if (!root || !root.querySelectorAll) return;
    var tables = root.querySelectorAll('table');
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      if (t.parentElement && t.parentElement.classList.contains('md-table-wrap')) continue;
      var wrap = document.createElement('div');
      wrap.className = 'md-table-wrap';
      if (t.parentNode) {
        t.parentNode.insertBefore(wrap, t);
        wrap.appendChild(t);
      }
    }
  }

  function patchBubbles() {
    document.querySelectorAll('.assistant-bubble').forEach(function (b) {
      b.classList.add('min-w-0');
      b.style.maxWidth = '100%';
      b.style.overflow = 'hidden';
    });
  }

  var obs = new MutationObserver(function (muts) {
    ensureMarkdownStyles();
    muts.forEach(function (m) {
      if (!m.addedNodes) return;
      m.addedNodes.forEach(function (n) {
        if (n.nodeType !== 1) return;
        if (n.classList && n.classList.contains('markdown-body')) wrapMarkdownTables(n);
        else if (n.querySelectorAll) n.querySelectorAll('.markdown-body').forEach(wrapMarkdownTables);
        if (n.classList && n.classList.contains('assistant-bubble')) {
          n.classList.add('min-w-0');
          n.style.maxWidth = '100%';
          n.style.overflow = 'hidden';
        }
      });
    });
    patchBubbles();
  });

  function start() {
    ensureMarkdownStyles();
    patchBubbles();
    document.querySelectorAll('.markdown-body').forEach(wrapMarkdownTables);
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  function tryPatchMarked() {
    var m = window.marked;
    if (!m) return;
    try {
      if (typeof m.setOptions === 'function') m.setOptions({ gfm: true, breaks: true });
      else if (m.marked && typeof m.marked.setOptions === 'function') m.marked.setOptions({ gfm: true, breaks: true });
    } catch (_) {}
  }
  tryPatchMarked();
  setTimeout(tryPatchMarked, 500);
  setTimeout(tryPatchMarked, 2000);
})();
