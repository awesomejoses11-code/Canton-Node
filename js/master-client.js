/**
 * Temporary bootstrap: load the last known-good master-client.js
 * from commit 02f9c16 until the full file is restored on main.
 * This unblocks mobile users without a local git terminal.
 */
(function () {
  'use strict';

  var SOURCES = [
    'https://cdn.jsdelivr.net/gh/awesomejoses11-code/Canton-Node@02f9c16cfa91e292938a15483fe1705a0ab3d4e2/js/master-client.js',
    'https://fastly.jsdelivr.net/gh/awesomejoses11-code/Canton-Node@02f9c16cfa91e292938a15483fe1705a0ab3d4e2/js/master-client.js'
  ];

  function load(i) {
    if (i >= SOURCES.length) {
      console.error('[master-client] failed to restore from CDN');
      return;
    }
    var s = document.createElement('script');
    s.src = SOURCES[i];
    s.async = false;
    s.onload = function () {
      console.info('[master-client] restored from', SOURCES[i]);
    };
    s.onerror = function () {
      load(i + 1);
    };
    document.head.appendChild(s);
  }

  load(0);
})();
