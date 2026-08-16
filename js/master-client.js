(function () {
  'use strict';
  var base = (document.currentScript && document.currentScript.src) || '/js/master-client.js';
  var root = base.replace(/master-client\.js.*$/, '');
  function get(i) {
    return fetch(root + 'mc-mem-p' + i + '.js.txt?v=mem1').then(function (r) {
      if (!r.ok) throw new Error('mc-mem-p' + i + ' ' + r.status);
      return r.text();
    });
  }
  Promise.all([get(0), get(1), get(2)]).then(function (parts) {
    var src = parts.join('');
    var s = document.createElement('script');
    s.textContent = src;
    document.head.appendChild(s);
  }).catch(function (e) {
    console.error('[master-client] failed to assemble', e);
  });
})();
