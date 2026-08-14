/**
 * master-client loader — multi-CDN (Chrome often blocks a single host).
 * Prefer raw GitHub, then jsDelivr/fastly. Shows error if all fail.
 */
(function () {
  'use strict';

  var COMMIT = '02f9c16cfa91e292938a15483fe1705a0ab3d4e2';
  var SOURCES = [
    'https://raw.githubusercontent.com/awesomejoses11-code/Canton-Node/' + COMMIT + '/js/master-client.js',
    'https://cdn.jsdelivr.net/gh/awesomejoses11-code/Canton-Node@' + COMMIT + '/js/master-client.js',
    'https://fastly.jsdelivr.net/gh/awesomejoses11-code/Canton-Node@' + COMMIT + '/js/master-client.js'
  ];

  function load(i) {
    if (i >= SOURCES.length) {
      console.error('[master-client] all CDN sources failed');
      var thread = document.getElementById('master-thread');
      if (thread) {
        var p = document.createElement('p');
        p.className = 'text-xs text-rose-600 text-center py-4';
        p.textContent = 'Master client failed to load (CDN blocked). Hard-refresh or try another network.';
        thread.appendChild(p);
      }
      return;
    }
    var s = document.createElement('script');
    s.src = SOURCES[i];
    s.async = false;
    s.onload = function () {
      console.info('[master-client] loaded from', SOURCES[i]);
    };
    s.onerror = function () { load(i + 1); };
    document.head.appendChild(s);
  }

  load(0);
})();
