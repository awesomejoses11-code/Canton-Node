(function () {
  'use strict';

  var currentSessionId = null;
  var attachedFiles = [];
  var MAX_ATTACH_COUNT = 8;
  var EXECUTABLE = { image: 1, video: 1, music: 1, tts: 1, code: 1, html2image: 1, mcp: 1, browse: 1 };
  var MAX_ATTACH_BYTES = 4 * 1024 * 1024;
  var assistantReplyCount = 0;

  function fileToAttachment(file) {
    return new Promise(function (resolve, reject) {
      if (!file) return resolve(null);
      if (file.size > MAX_ATTACH_BYTES) {
        return reject(new Error('File too large (max 4MB). Try a smaller file or crop the image.'));
      }
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read file')); };
      var isText = /^(text\/|application\/(json|xml|javascript|x-javascript))/.test(file.type) ||
        /\.(txt|md|csv|json|js|ts|py|html|css|xml|svg)$/i.test(file.name);
      if (isText) {
        reader.onload = function () {
          resolve({
            name: file.name, type: file.type || 'text/plain', kind: 'text',
            text: String(reader.result || '').slice(0, 120000)
          });
        };
        reader.readAsText(file);
      } else {
        reader.onload = function () {
          resolve({
            name: file.name, type: file.type || 'application/octet-stream',
            kind: file.type.indexOf('image/') === 0 ? 'image' : 'binary',
            dataUrl: String(reader.result || ''), size: file.size
          });
        };
        reader.readAsDataURL(file);
      }
    });
  }

  function email() {
    var u = window.Auth && Auth.current && Auth.current();
    return u ? u.email : null;
  }

  function sessionToken() {
    try {
      var u = window.Auth && Auth.current && Auth.current();
      if (u && u.token) return u.token;
    } catch (_) {}
    try {
      for (var i = 0; i < 2; i++) {
        var store = i === 0 ? sessionStorage : localStorage;
        var raw = store.getItem('prexzy.session.v1');
        if (!raw) continue;
        var p = JSON.parse(raw);
        if (p && p.token) return p.token;
      }
    } catch (_) {}
    return null;
  }

  function el(id) { return document.getElementById(id); }

  /* rest of file continues from remote - TOKEN_PATCH_ONLY */
})();
