/* docs-link.js — add Docs → GitHub in header/footer without touching compressed index payload */
(function () {
  'use strict';
  var REPO = 'https://github.com/awesomejoses11-code/Canton-Node';

  function makeLink(cls) {
    var a = document.createElement('a');
    a.href = REPO;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Docs';
    a.title = 'Canton Node on GitHub';
    a.className = cls || 'text-xs text-slate-500 hover:text-brand-600 underline-offset-2 hover:underline';
    return a;
  }

  function inject() {
    if (document.getElementById('canton-docs-link')) return;

    // Prefer header near Logout
    var logout = document.getElementById('btn-logout');
    if (logout && logout.parentNode) {
      var a = makeLink('text-xs px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800');
      a.id = 'canton-docs-link';
      logout.parentNode.insertBefore(a, logout);
      return;
    }

    // Footer fallback
    var footers = document.querySelectorAll('footer, .app-footer, [data-footer]');
    if (footers.length) {
      var a2 = makeLink();
      a2.id = 'canton-docs-link';
      footers[0].appendChild(a2);
      return;
    }

    // Last resort: fixed chip
    var chip = document.createElement('div');
    chip.id = 'canton-docs-link';
    chip.style.cssText = 'position:fixed;bottom:10px;right:10px;z-index:40;';
    var a3 = makeLink('text-xs bg-white/90 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-700 rounded-full px-3 py-1 shadow');
    chip.appendChild(a3);
    document.body.appendChild(chip);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
  // Re-try after auth shell mounts
  setTimeout(inject, 800);
})();
