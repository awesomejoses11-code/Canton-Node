/**
 * Same-origin restore of full master-client (commit 02f9c16).
 * Chrome-safe: no external CDN — fetch local chunks and inject.
 */
(function () {
  'use strict';
  var PARTS = ['/js/mc-p0.js.txt', '/js/mc-p1.js.txt', '/js/mc-p2.js.txt'];

  function fail(msg) {
    console.error('[master-client]', msg);
    var t = document.getElementById('master-thread');
    if (t) {
      var p = document.createElement('p');
      p.className = 'text-xs text-rose-600 text-center py-4';
      p.textContent = msg;
      t.appendChild(p);
    }
  }

  Promise.all(PARTS.map(function (u) {
    return fetch(u, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(u + ' HTTP ' + r.status);
      return r.text();
    });
  })).then(function (chunks) {
    var code = chunks.join('');
    if (code.indexOf('currentSessionId') === -1) throw new Error('bad payload');
    var s = document.createElement('script');
    s.textContent = code;
    document.head.appendChild(s);
    console.info('[master-client] restored same-origin chunks (' + code.length + ' bytes)');
  }).catch(function (e) {
    fail('Master client restore failed: ' + (e && e.message ? e.message : e));
  });
})();
