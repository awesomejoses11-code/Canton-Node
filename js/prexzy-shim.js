/* prexzy-shim.js — ensure PrexzyAPI is always defined before master-client */
(function (g) {
  'use strict';
  if (!g.PrexzyAPI) {
    console.warn('[shim] PrexzyAPI missing — api.js may have failed to load');
    g.PrexzyAPI = {
      describe: function () { return null; },
      call: function () { return Promise.reject(new Error('PrexzyAPI not loaded')); },
      callResilient: function () { return Promise.reject(new Error('PrexzyAPI not loaded')); },
      generateImage: function () { return Promise.reject(new Error('PrexzyAPI not loaded')); },
      generateVideo: function () { return Promise.reject(new Error('PrexzyAPI not loaded')); },
      runRoute: function () { return Promise.reject(new Error('PrexzyAPI not loaded')); },
      showLoading: function () { return { setMessage: function () {}, clear: function () {} }; },
      PrexzyError: function (kind, msg) { var e = new Error(msg); e.kind = kind; return e; }
    };
  }
})(window);
