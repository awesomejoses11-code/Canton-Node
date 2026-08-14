/**
 * master-client bootstrap — fetch source as text, inject inline.
 * Avoids Chrome / extension blocks on cross-origin <script src>.
 * Also fixes missing attach + history when CDN script tags fail.
 */
(function () {
  'use strict';

  var COMMIT = '02f9c16cfa91e292938a15483fe1705a0ab3d4e2';
  var SOURCES = [
    'https://cdn.jsdelivr.net/gh/awesomejoses11-code/Canton-Node@' + COMMIT + '/js/master-client.js',
    'https://fastly.jsdelivr.net/gh/awesomejoses11-code/Canton-Node@' + COMMIT + '/js/master-client.js',
    'https://raw.githubusercontent.com/awesomejoses11-code/Canton-Node/' + COMMIT + '/js/master-client.js'
  ];

  function showFail(msg) {
    console.error('[master-client]', msg);
    var thread = document.getElementById('master-thread');
    if (!thread) return;
    var p = document.createElement('p');
    p.className = 'text-xs text-rose-600 dark:text-rose-400 text-center py-4 px-2';
    p.textContent = msg;
    thread.appendChild(p);
  }

  function inject(code, from) {
    var s = document.createElement('script');
    s.textContent = code;
    document.head.appendChild(s);
    console.info('[master-client] injected from', from);
  }

  function tryFetch(i) {
    if (i >= SOURCES.length) {
      showFail('Master client failed to load. Disable blockers for this site, or hard-refresh. Attach + history need this script.');
      return;
    }
    var url = SOURCES[i];
    fetch(url, { mode: 'cors', cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (code) {
        if (!code || (code.indexOf('MasterChat') === -1 && code.indexOf('currentSessionId') === -1)) {
          throw new Error('unexpected payload');
        }
        inject(code, url);
      })
      .catch(function (err) {
        console.warn('[master-client] source failed', url, err && err.message);
        tryFetch(i + 1);
      });
  }

  tryFetch(0);
})();
