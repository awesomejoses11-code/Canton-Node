/* =========================================================================
 * master-client.js — Browser side of the Master Agent
 *
 * Sends the natural-language request to /api/master, which routes it via
 * an OpenRouter free-model chain (Free Models Router → GPT-OSS 20B →
 * Gemma 4 31B).
 *
 * For image/music/video/code/tts/html2image/image2html, /api/master only
 * returns a routing decision — this file shows it and, on "Execute on
 * Prexzy", runs the routed endpoint through PrexzyAPI so the usual
 * quota/refund rules apply.
 *
 * For chat/web, /api/master now does the work itself server-side (rotating
 * across Prexzy's text endpoints, then falling back to OpenRouter
 * generation if all of them fail) and returns `server_executed: true` with
 * the actual answer in `result`. There's nothing left to execute — this
 * file renders `result` directly and hides the Execute button. One
 * consequence: because PrexzyAPI.call() is never invoked on that path, the
 * "chat"/"web" quota buckets are NOT decremented when answered through the
 * Master Agent (they still work normally from the chat/web agent cards).
 *
 * Quota: routing always consumes the `master` bucket, regardless of which
 * agent gets picked or whether it ends up server-executed.
 * ========================================================================= */

(function () {
  'use strict';

  let lastRoute = null; // last routing decision, used by "Execute on Prexzy"
  let attachedFile = null; // File object from the composer's attach button

  // Features that trigger the "confirm before heavy calls" setting.
  const HEAVY_FEATURES = new Set(['image', 'music', 'video']);

  // Human-readable label per server-side execution source (chat/web only).
  const SOURCE_LABELS = {
    'prexzy':           (d) => 'Prexzy — ' + d.endpoint,
    'openrouter':        (d) => 'OpenRouter — generated directly (' + (d.model_used || 'fallback model') + ')',
    'openrouter-online': (d) => 'OpenRouter — generated with live web search (' + (d.model_used || 'fallback model') + ')'
  };

  function clearAttachment() {
    attachedFile = null;
    document.getElementById('master-file-input').value = '';
    document.getElementById('master-attachment').classList.add('hidden');
  }

  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
  }

  async function runMasterAgent() {
    const input     = document.getElementById('master-input');
    const resultBox = document.getElementById('master-result');
    const actions   = document.getElementById('master-actions');
    const runBtn    = document.getElementById('master-run');
    const badge     = document.getElementById('master-model-badge');
    const message   = input.value.trim();
    if (!message) return;

    const settings = Settings.load((Auth.current() || {}).email);
    if (settings.routingMode === 'manual') {
      show(resultBox, 'Routing mode is set to "Manual selection only" in Settings — pick an agent card below instead.');
      actions.classList.add('hidden');
      return;
    }

    // Master routing consumes the `master` quota bucket.
    const c = Quota.consume('master');
    if (!c.ok) {
      show(resultBox, 'Daily Master Agent routing limit reached (' + Quota.limit('master') + '/day). Resets at midnight.');
      actions.classList.add('hidden');
      return;
    }

    runBtn.disabled = true;
    show(resultBox, 'Routing your request…');
    actions.classList.add('hidden');

    let refunded = false;
    const refundOnce = () => { if (!refunded) { Quota.refund('master'); refunded = true; } };

    try {
      const res = await fetch('/api/master', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message,
          attachment: attachedFile ? { name: attachedFile.name, type: attachedFile.type } : null
        })
      });
      const data = await res.json();

      if (!res.ok) {
        refundOnce();
        show(resultBox, 'Error: ' + (data.error || res.status) + (data.detail ? '\n' + data.detail : ''));
        return;
      }

      lastRoute = data;
      badge.textContent = (data.model_used || 'router') + (data.fallback_used ? ' (fallback)' : '');

      if (data.server_executed) {
        // chat / web — /api/master already ran this (Prexzy rotation, then
        // OpenRouter generation if every Prexzy endpoint failed). Nothing
        // left for the browser to execute.
        renderServerExecutedResult(resultBox, data);
        actions.classList.add('hidden');
        if (attachedFile) clearAttachment(); // no endpoint on this path accepts image input
      } else {
        let text =
          'agent: '     + data.agent_id + '\n' +
          'endpoint: '  + data.endpoint + '\n' +
          'params: '    + JSON.stringify(data.params, null, 2) + '\n' +
          'reasoning: ' + data.reasoning +
          (data.fallback_note ? '\n\n⚠ ' + data.fallback_note : '');
        if (attachedFile) {
          text += '\n\n📎 "' + attachedFile.name + '" attached, but no wired endpoint accepts image input yet — it won\'t be sent to Prexzy.';
          clearAttachment();
        }
        show(resultBox, text);
        // Only offer execution when the routed endpoint exists in the wrapper.
        actions.classList.toggle('hidden', !PrexzyAPI.describe(data.endpoint));
      }
    } catch (e) {
      refundOnce();
      show(resultBox, 'Request failed: ' + e.message);
    } finally {
      runBtn.disabled = false;
    }
  }

  /** Renders a server-executed chat/web answer (data.result) plus its source + any fallback note. */
  function renderServerExecutedResult(box, data) {
    box.classList.remove('hidden');
    box.innerHTML = '';

    if (!data.result) {
      box.classList.add('whitespace-pre-wrap');
      box.textContent = 'Could not get an answer.' + (data.fallback_note ? '\n\n' + data.fallback_note : '');
      return;
    }
    box.classList.remove('whitespace-pre-wrap');

    const answerEl = document.createElement('div');
    answerEl.className = 'whitespace-pre-wrap text-slate-800 dark:text-slate-100';
    answerEl.textContent = data.result;

    const labelFn = SOURCE_LABELS[data.source];
    const metaEl = document.createElement('div');
    metaEl.className = 'mt-3 pt-2 border-t border-slate-200 dark:border-slate-700 text-[11px] text-slate-400 font-mono';
    metaEl.textContent = 'via ' + (labelFn ? labelFn(data) : data.source) +
      ' · chat/web quota isn\'t deducted for Master Agent answers';

    box.append(answerEl, metaEl);

    if (data.fallback_note) {
      const noteEl = document.createElement('div');
      noteEl.className = 'mt-2 text-[11px] text-amber-600 dark:text-amber-400';
      noteEl.textContent = '⚠ ' + data.fallback_note;
      box.append(noteEl);
    }
  }

  async function executeRoute() {
    if (!lastRoute) return;
    const resultBox = document.getElementById('master-result');
    const endpoint  = PrexzyAPI.describe(lastRoute.endpoint);
    if (!endpoint) return;

    const settings = Settings.load((Auth.current() || {}).email);
    if (settings.confirmHeavy && endpoint.feature && HEAVY_FEATURES.has(endpoint.feature)) {
      const left = Quota.remaining(endpoint.feature);
      if (!confirm(`This will use 1 ${endpoint.feature} call (${left} left today). Continue?`)) return;
    }

    show(resultBox, 'Executing ' + lastRoute.endpoint + ' on Prexzy…');
    try {
      const data = await PrexzyAPI.callResilient(lastRoute.endpoint, lastRoute.params);
      renderExecutionResult(resultBox, data);
    } catch (e) {
      show(resultBox, (e.kind ? '[' + e.kind + '] ' : '') + e.message);
    }
  }

  // Field names that commonly carry a media URL across different Prexzy
  // endpoints — same detection idea as the downloader tool, adapted for the
  // flat JSON objects Prexzy actually returns (no nested `type`/`url` pairs).
  const MEDIA_FIELDS = {
    image: ['image_url', 'img_url', 'imageUrl', 'photo_url'],
    video: ['video_url', 'videoUrl'],
    audio: ['audio_url', 'audioUrl', 'voice_url', 'tts_url']
  };

  function findMediaUrl(data) {
    if (!data || typeof data !== 'object') return null;
    for (const [kind, fields] of Object.entries(MEDIA_FIELDS)) {
      for (const f of fields) {
        if (typeof data[f] === 'string' && /^https?:\/\//i.test(data[f])) {
          return { kind, url: data[f] };
        }
      }
    }
    // Generic fallback for endpoints that use a field name we haven't
    // listed above: any "*url"-named field pointing at an obvious media file.
    for (const [key, val] of Object.entries(data)) {
      if (typeof val !== 'string' || !/^https?:\/\//i.test(val)) continue;
      if (!/url$/i.test(key)) continue;
      if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(val)) return { kind: 'image', url: val };
      if (/\.(mp4|webm|mov)(\?|$)/i.test(val))        return { kind: 'video', url: val };
      if (/\.(mp3|wav|ogg|m4a)(\?|$)/i.test(val))     return { kind: 'audio', url: val };
    }
    return null;
  }

  // One plain-English line instead of the raw object, e.g.
  // 'Generated image for: "a swimming fish"'.
  function summarize(data, media) {
    if (data.prompt) {
      return media
        ? `Generated ${media.kind} for: "${data.prompt}"`
        : `Done — prompt: "${data.prompt}"`;
    }
    if (data.result || data.response || data.answer || data.message) {
      return String(data.result || data.response || data.answer || data.message);
    }
    return media ? `Generated ${media.kind}.` : 'Request completed.';
  }

  function renderExecutionResult(box, data) {
    // Pre-normalized binary shape, if PrexzyAPI.call ever returns one.
    if (data && data._binary) {
      renderMedia(box, {
        kind: data.contentType.startsWith('image/') ? 'image'
            : data.contentType.startsWith('audio/') ? 'audio' : 'video',
        url: data.url
      }, data._text || 'Done.');
      return;
    }

    // Raw Prexzy JSON — the shape most endpoints actually return today,
    // e.g. { status, prompt, image_url, job_id }.
    if (data && typeof data === 'object') {
      const media = findMediaUrl(data);
      if (media) {
        renderMedia(box, media, summarize(data, media));
        return;
      }
      if (data._text) { show(box, data._text); return; }
      if (data.result || data.response || data.answer || data.message) {
        show(box, summarize(data, null));
        return;
      }
    }

    // Nothing recognizable — show raw JSON, but labeled as a fallback
    // rather than presented as if it were the intended output.
    show(box, 'Unrecognized response shape — raw output:\n' + JSON.stringify(data, null, 2));
  }

  function renderMedia(box, media, caption) {
    box.classList.remove('hidden');
    box.innerHTML = '';
    const captionEl = document.createElement('div');
    captionEl.className = 'mb-2 text-slate-700 dark:text-slate-200';
    captionEl.textContent = caption;
    const el = document.createElement(media.kind === 'image' ? 'img' : media.kind === 'audio' ? 'audio' : 'video');
    el.src = media.url;
    if (media.kind !== 'image') el.controls = true;
    el.className = 'max-w-full rounded-lg';
    const link = document.createElement('a');
    link.href = media.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.download = 'canton-node-result';
    link.className = 'block mt-2 text-brand-600 dark:text-brand-500 underline text-xs';
    link.textContent = '⬇ Download';
    box.append(captionEl, el, link);
  }

  function show(el, text) {
    el.classList.remove('hidden');
    el.textContent = text;
  }

  document.addEventListener('DOMContentLoaded', () => {
    const textarea   = document.getElementById('master-input');
    const attachBtn   = document.getElementById('master-attach');
    const fileInput   = document.getElementById('master-file-input');
    const attachChip  = document.getElementById('master-attachment');
    const attachName  = document.getElementById('master-attachment-name');
    const removeBtn   = document.getElementById('master-attachment-remove');

    document.getElementById('master-run').addEventListener('click', runMasterAgent);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runMasterAgent();
      }
    });
    textarea.addEventListener('input', () => autoGrow(textarea));

    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      attachedFile = file;
      attachName.textContent = file.name;
      attachChip.classList.remove('hidden');
    });
    removeBtn.addEventListener('click', clearAttachment);

    document.getElementById('master-execute').addEventListener('click', executeRoute);
  });

})();
