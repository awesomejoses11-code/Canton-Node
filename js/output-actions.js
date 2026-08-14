/* =========================================================================
 * output-actions.js — Copy / Download / Edit / Refresh controls
 *
 * Every image, audio, video, and code block the app renders should be
 * independently downloadable or copyable, without depending on the user
 * right-clicking a media element. This file is the one place that builds
 * those controls, so every renderer (master-client.js today, specialist
 * agents later) gets the same behavior for free.
 *
 * attachMediaControls(container, mediaEl, url, kind, filenameBase)
 *   Adds a "⬇ Download" + "⧉ Copy image" / "⧉ Copy link" row under an
 *   <img>/<audio>/<video>. Tries a real blob download/clipboard-image copy
 *   first (works for same-origin or CORS-enabled URLs); if the fetch is
 *   blocked (cross-origin without CORS), falls back to opening the file in
 *   a new tab / copying the URL text instead of silently doing nothing.
 *
 * attachCodeControls(container, code, filenameBase, ext)
 *   Adds a "⧉ Copy code" + "⬇ Download" row for a plain string of code/text
 *   — no network involved, so this one always works.
 *
 * enhanceCodeBlocks(root)
 *   Scans a markdown-rendered container for <pre><code> blocks (fenced code
 *   from marked.js) and attaches attachCodeControls to each one it hasn't
 *   already touched. Called automatically from master-client.js's
 *   renderMarkdown(), so any answer with code fences gets per-block
 *   controls with no extra wiring at the call site.
 *
 * attachMessageActions(box, opts)
 *   Adds Copy / Edit / Refresh under an assistant bubble (route cards,
 *   chat answers, execution results).
 * ========================================================================= */

(function (global) {
  'use strict';

  const BTN_CLASS =
    'inline-flex items-center gap-1 text-[11px] rounded-md border border-slate-300 dark:border-slate-600 ' +
    'px-2 py-1 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors';

  function actionBtn(label, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = BTN_CLASS;
    b.textContent = label;
    if (title) b.title = title;
    return b;
  }

  function flash(btn, text, ms) {
    if (btn.dataset.flashing) return;
    const original = btn.textContent;
    btn.dataset.flashing = '1';
    btn.textContent = text;
    setTimeout(function () {
      btn.textContent = original;
      delete btn.dataset.flashing;
    }, ms || 1200);
  }

  function extFromUrl(url, kind) {
    const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(url || '');
    if (m) return m[1].toLowerCase();
    return kind === 'image' ? 'png' : kind === 'audio' ? 'mp3' : 'mp4';
  }

  async function fetchAsBlob(url) {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error('fetch failed: ' + res.status);
    return await res.blob();
  }

  function triggerBlobDownload(blob, filename) {
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(objUrl); }, 4000);
  }

  async function downloadMedia(url, filename, btn) {
    try {
      var blob;
      if (/^blob:/i.test(url)) {
        var res = await fetch(url);
        blob = await res.blob();
      } else if (/^data:/i.test(url)) {
        var r = await fetch(url);
        blob = await r.blob();
      } else {
        blob = await fetchAsBlob(url);
      }
      triggerBlobDownload(blob, filename);
      flash(btn, '✓ Saved');
    } catch (e) {
      window.open(url, '_blank', 'noopener');
      flash(btn, 'Opened ↗', 1500);
    }
  }

  async function copyText(text, btn, okLabel) {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard API');
      await navigator.clipboard.writeText(text);
      if (btn) flash(btn, okLabel || '✓ Copied');
    } catch (e) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        if (btn) flash(btn, okLabel || '✓ Copied');
      } catch (e2) {
        if (btn) flash(btn, 'Copy failed', 1500);
      }
      ta.remove();
    }
  }

  async function copyImageToClipboard(url, btn) {
    try {
      if (!navigator.clipboard || !window.ClipboardItem) throw new Error('unsupported');
      var blob;
      if (/^data:/i.test(url) || /^blob:/i.test(url)) {
        var r = await fetch(url);
        blob = await r.blob();
      } else {
        blob = await fetchAsBlob(url);
      }
      var item = new ClipboardItem({ [blob.type || 'image/png']: blob });
      await navigator.clipboard.write([item]);
      flash(btn, '✓ Copied');
    } catch (e) {
      await copyText(url, btn, '✓ Link copied');
    }
  }

  function attachMediaControls(container, mediaEl, url, kind, filenameBase) {
    if (!container) return null;
    if (container.querySelector('[data-oa-media]')) return null;

    var row = document.createElement('div');
    row.setAttribute('data-oa-media', '1');
    row.className = 'mt-2 flex items-center gap-2 flex-wrap font-sans';

    var dl = actionBtn('⬇ Download', 'Save this ' + kind + ' to your device');
    var ext = extFromUrl(url, kind);
    dl.addEventListener('click', function () {
      downloadMedia(url, (filenameBase || 'canton-node-' + kind) + '.' + ext, dl);
    });
    row.appendChild(dl);

    if (kind === 'image') {
      var cp = actionBtn('⧉ Copy image', 'Copy image to clipboard');
      cp.addEventListener('click', function () { copyImageToClipboard(url, cp); });
      row.appendChild(cp);
    } else {
      var cp2 = actionBtn('⧉ Copy link', 'Copy the media URL');
      cp2.addEventListener('click', function () { copyText(url, cp2); });
      row.appendChild(cp2);
    }

    container.appendChild(row);
    return row;
  }

  function attachCodeControls(container, code, filenameBase, ext) {
    if (!container) return null;
    var row = document.createElement('div');
    row.className = 'mt-2 flex items-center gap-2 flex-wrap font-sans';

    var cp = actionBtn('⧉ Copy code', 'Copy to clipboard');
    cp.addEventListener('click', function () { copyText(code, cp); });
    row.appendChild(cp);

    var dl = actionBtn('⬇ Download', 'Save as a file');
    dl.addEventListener('click', function () {
      triggerBlobDownload(
        new Blob([code], { type: 'text/plain' }),
        (filenameBase || 'canton-node-code') + '.' + (ext || 'txt')
      );
      flash(dl, '✓ Saved');
    });
    row.appendChild(dl);

    container.appendChild(row);
    return row;
  }

  var LANG_EXT = {
    javascript: 'js', js: 'js', jsx: 'jsx', typescript: 'ts', ts: 'ts', tsx: 'tsx',
    python: 'py', py: 'py', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp',
    csharp: 'cs', 'c#': 'cs', html: 'html', xml: 'xml', css: 'css', json: 'json',
    bash: 'sh', shell: 'sh', sh: 'sh', sql: 'sql', go: 'go', rust: 'rs', rs: 'rs',
    php: 'php', ruby: 'rb', rb: 'rb', yaml: 'yml', yml: 'yml', markdown: 'md', md: 'md'
  };

  function enhanceCodeBlocks(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('pre').forEach(function (pre, i) {
      if (pre.dataset.actionsAttached) return;
      pre.dataset.actionsAttached = '1';
      var codeEl = pre.querySelector('code') || pre;
      var langMatch = /language-([\w+#]+)/.exec(codeEl.className || '');
      var lang = langMatch ? langMatch[1].toLowerCase() : '';
      var wrap = document.createElement('div');
      pre.insertAdjacentElement('afterend', wrap);
      attachCodeControls(wrap, codeEl.textContent, 'canton-node-snippet-' + (i + 1), LANG_EXT[lang] || 'txt');
    });
  }

  function attachMessageActions(box, opts) {
    opts = opts || {};
    if (!box || box.querySelector('[data-oa]')) return;

    var bar = document.createElement('div');
    bar.setAttribute('data-oa', '1');
    bar.className = 'flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-slate-200 dark:border-slate-700 font-sans';

    var copyBtn = actionBtn('Copy', 'Copy response to clipboard');
    copyBtn.addEventListener('click', function () {
      var text = opts.text || box.innerText || '';
      copyText(text, copyBtn);
    });
    bar.appendChild(copyBtn);

    if (opts.userPrompt) {
      var editBtn = actionBtn('Edit', 'Edit the original prompt');
      editBtn.addEventListener('click', function () {
        var input = document.getElementById('master-input');
        if (!input) return;
        input.value = opts.userPrompt;
        input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      bar.appendChild(editBtn);

      var refreshBtn = actionBtn('↻ Refresh', 'Re-run this prompt');
      refreshBtn.addEventListener('click', function () {
        var input = document.getElementById('master-input');
        var runBtn = document.getElementById('master-run');
        if (!input || !runBtn) return;
        input.value = opts.userPrompt;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        runBtn.click();
      });
      bar.appendChild(refreshBtn);
    }

    box.appendChild(bar);
  }

  function attach(box, text) {
    attachMessageActions(box, { text: text });
  }

  global.OutputActions = {
    attach: attach,
    attachMessageActions: attachMessageActions,
    attachMediaControls: attachMediaControls,
    attachCodeControls: attachCodeControls,
    enhanceCodeBlocks: enhanceCodeBlocks,
    copyText: function (text) { return copyText(text, null); }
  };
})(window);
