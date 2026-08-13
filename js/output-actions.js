/* =========================================================================
 * output-actions.js — Copy/Download controls for generated output.
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
 * ========================================================================= */

(function () {
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
    if (btn.dataset.flashing) return; // avoid stacking timeouts on fast double-clicks
    const original = btn.textContent;
    btn.dataset.flashing = '1';
    btn.textContent = text;
    setTimeout(() => {
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
    setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
  }

  async function downloadMedia(url, filename, btn) {
    try {
      const blob = await fetchAsBlob(url);
      triggerBlobDownload(blob, filename);
      flash(btn, '✓ Saved');
    } catch (e) {
      // Cross-origin without CORS — the `download` attribute is ignored by
      // browsers on cross-origin links, so a plain <a download> silently
      // just navigates. Open it directly instead so the user can Save As.
      window.open(url, '_blank', 'noopener');
      flash(btn, 'Opened ↗', 1500);
    }
  }

  async function copyText(text, btn, okLabel) {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard API');
      await navigator.clipboard.writeText(text);
      flash(btn, okLabel || '✓ Copied');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        flash(btn, okLabel || '✓ Copied');
      } catch (e2) {
        flash(btn, 'Copy failed', 1500);
      }
      ta.remove();
    }
  }

  async function copyImageToClipboard(url, btn) {
    try {
      if (!navigator.clipboard || !window.ClipboardItem) throw new Error('unsupported');
      const blob = await fetchAsBlob(url);
      const item = new ClipboardItem({ [blob.type || 'image/png']: blob });
      await navigator.clipboard.write([item]);
      flash(btn, '✓ Copied');
    } catch (e) {
      // Clipboard image writes need same-origin/CORS + browser support —
      // fall back to copying the link so the action still does *something*.
      await copyText(url, btn, '✓ Link copied');
    }
  }

  function attachMediaControls(container, mediaEl, url, kind, filenameBase) {
    const row = document.createElement('div');
    row.className = 'mt-2 flex items-center gap-2 flex-wrap';

    const dl = actionBtn('⬇ Download', 'Save this ' + kind + ' to your device');
    const ext = extFromUrl(url, kind);
    dl.addEventListener('click', () => downloadMedia(url, (filenameBase || 'canton-node-' + kind) + '.' + ext, dl));
    row.appendChild(dl);

    if (kind === 'image') {
      const cp = actionBtn('⧉ Copy image', 'Copy image to clipboard');
      cp.addEventListener('click', () => copyImageToClipboard(url, cp));
      row.appendChild(cp);
    } else {
      const cp = actionBtn('⧉ Copy link', 'Copy the media URL');
      cp.addEventListener('click', () => copyText(url, cp));
      row.appendChild(cp);
    }

    container.appendChild(row);
    return row;
  }

  function attachCodeControls(container, code, filenameBase, ext) {
    const row = document.createElement('div');
    row.className = 'mt-2 flex items-center gap-2 flex-wrap';

    const cp = actionBtn('⧉ Copy code', 'Copy to clipboard');
    cp.addEventListener('click', () => copyText(code, cp));
    row.appendChild(cp);

    const dl = actionBtn('⬇ Download', 'Save as a file');
    dl.addEventListener('click', () => {
      triggerBlobDownload(new Blob([code], { type: 'text/plain' }), (filenameBase || 'canton-node-code') + '.' + (ext || 'txt'));
      flash(dl, '✓ Saved');
    });
    row.appendChild(dl);

    container.appendChild(row);
    return row;
  }

  // Fenced-code language tag → sensible file extension, so downloads open
  // with the right association instead of always landing as .txt.
  const LANG_EXT = {
    javascript: 'js', js: 'js', jsx: 'jsx', typescript: 'ts', ts: 'ts', tsx: 'tsx',
    python: 'py', py: 'py', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp',
    csharp: 'cs', 'c#': 'cs', html: 'html', xml: 'xml', css: 'css', json: 'json',
    bash: 'sh', shell: 'sh', sh: 'sh', sql: 'sql', go: 'go', rust: 'rs', rs: 'rs',
    php: 'php', ruby: 'rb', rb: 'rb', yaml: 'yml', yml: 'yml', markdown: 'md', md: 'md'
  };

  function enhanceCodeBlocks(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('pre').forEach((pre, i) => {
      if (pre.dataset.actionsAttached) return;
      pre.dataset.actionsAttached = '1';
      const codeEl = pre.querySelector('code') || pre;
      const langMatch = /language-([\w+#]+)/.exec(codeEl.className || '');
      const lang = langMatch ? langMatch[1].toLowerCase() : '';
      const wrap = document.createElement('div');
      pre.insertAdjacentElement('afterend', wrap);
      attachCodeControls(wrap, codeEl.textContent, 'canton-node-snippet-' + (i + 1), LANG_EXT[lang] || 'txt');
    });
  }

  window.OutputActions = { attachMediaControls, attachCodeControls, enhanceCodeBlocks, copyText };
})();
