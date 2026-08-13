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
 * For chat/web, /api/master does the work itself server-side — generated
 * directly via the OpenRouter free-model chain, no Prexzy involved — and
 * returns `server_executed: true` with the actual answer text in `result`.
 * There's nothing left to execute — this file renders `result` directly.
 * One consequence: because PrexzyAPI.call() is never invoked on that path,
 * the "chat"/"web" quota buckets are NOT decremented when answered through
 * the Master Agent (they still work normally from the chat/web agent cards).
 *
 * MARKDOWN (added): assistant text answers are parsed with marked.js and
 * sanitized with DOMPurify before being inserted as HTML — headers, bold,
 * italics, lists, links, code fences etc. render styled instead of showing
 * raw `##`/`**` syntax. See renderMarkdown() below. Two script tags in
 * index.html (marked, DOMPurify) must load before this file; if either is
 * missing for any reason this degrades to plain text rather than breaking.
 * Only assistant prose gets this treatment — user bubbles and the raw
 * agent/endpoint/params routing dump stay as plain monospace text, and
 * agent_id "code" answers stay as plain monospace text too (markdown
 * auto-formatting would mangle raw code, e.g. underscores in identifiers
 * read as italics).
 *
 * Quota: routing always consumes the `master` bucket, regardless of which
 * agent gets picked or whether it ends up server-executed.
 *
 * CHAT HISTORY: the Master Agent is a real conversation, not a one-shot
 * box. Every user/assistant turn renders as a bubble in #master-thread and
 * is persisted via history.js into a per-user session (no projects, no
 * artifacts — just a flat, linear chat). Prior turns of the active session
 * are sent to /api/master as `history` so follow-ups ("make it shorter",
 * "now turn that into an image") resolve with real context. A slide-out
 * drawer (#history-drawer) lists past sessions — click to reopen, ✕ to
 * delete, "+ New Chat" to start fresh.
 *
 * Routed-but-not-executed turns (image/music/video/etc.) keep their own
 * "Execute on Prexzy" button scoped to that specific message — there's no
 * single global "last route" anymore since multiple routed turns can sit
 * in the same thread.
 * ========================================================================= */

(function () {
  'use strict';

  let currentSessionId = null;   // active chat session id, or null (no chat started yet)
  let attachedFile = null;       // File object from the composer's attach button

  // Features that trigger the "confirm before heavy calls" setting.
  const HEAVY_FEATURES = new Set(['image', 'music', 'video']);

  // Human-readable label per server-side execution source (chat/web only).
  const SOURCE_LABELS = {
    'openrouter':        (d) => 'OpenRouter — ' + (d.model_used || 'fallback model'),
    'openrouter-online': (d) => 'OpenRouter — with live web search (' + (d.model_used || 'fallback model') + ')'
  };

  function getEmail() {
    const u = Auth.current();
    return u ? u.email : null;
  }

  function clearAttachment() {
    attachedFile = null;
    document.getElementById('master-file-input').value = '';
    document.getElementById('master-attachment').classList.add('hidden');
  }

  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
  }

  /** Parses `text` as markdown (marked.js) and sanitizes the result (DOMPurify)
   *  before writing it into `el` as HTML. Falls back to plain text if either
   *  library failed to load — never leaves the element blank. */
  function renderMarkdown(el, text) {
    if (window.marked) {
      const raw = marked.parse(String(text == null ? '' : text), { breaks: true, gfm: true });
      el.innerHTML = window.DOMPurify ? DOMPurify.sanitize(raw) : raw;
      el.classList.add('markdown-body');
      if (window.OutputActions) window.OutputActions.enhanceCodeBlocks(el); // copy/download per code fence
    } else {
      el.classList.add('whitespace-pre-wrap');
      el.textContent = text;
    }
  }

  /* -------------------------------------------------------------------
   * Thread rendering — a plain scrolling list of message bubbles inside
   * #master-thread. User bubbles right-aligned; assistant bubbles left-
   * aligned. Assistant bubbles reuse the same render* helpers the old
   * single result box used, just pointed at a per-message element.
   * ------------------------------------------------------------------- */

  function threadEl() { return document.getElementById('master-thread'); }

  function clearThreadDOM() {
    const t = threadEl();
    t.innerHTML = '';
    const p = document.createElement('p');
    p.id = 'master-thread-empty';
    p.className = 'text-xs text-slate-400 text-center py-6';
    p.textContent = 'No messages yet — start a conversation below.';
    t.appendChild(p);
  }

  function hideEmptyState() {
    const p = document.getElementById('master-thread-empty');
    if (p) p.remove();
  }

  function scrollThreadToBottom() {
    const t = threadEl();
    t.scrollTop = t.scrollHeight;
  }

  function appendUserBubble(message) {
    hideEmptyState();
    const wrap = document.createElement('div');
    wrap.className = 'flex justify-end';
    const bubble = document.createElement('div');
    bubble.className = 'max-w-[85%] rounded-2xl bg-brand-600 text-white text-sm px-3 py-2 whitespace-pre-wrap';
    bubble.textContent = message.content;
    if (message.meta && message.meta.attachmentName) {
      const chip = document.createElement('div');
      chip.className = 'mt-1 text-[11px] text-brand-100 opacity-80';
      chip.textContent = '📎 ' + message.meta.attachmentName;
      bubble.appendChild(chip);
    }
    wrap.appendChild(bubble);
    threadEl().appendChild(wrap);
    scrollThreadToBottom();
  }

  /** Appends an empty assistant bubble and returns its inner element (the "box" render* helpers write into). */
  function appendAssistantBubble() {
    hideEmptyState();
    const wrap = document.createElement('div');
    wrap.className = 'flex justify-start';
    const bubble = document.createElement('div');
    bubble.className = 'max-w-[92%] w-full sm:w-auto rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs sm:text-sm px-3 py-2';
    wrap.appendChild(bubble);
    threadEl().appendChild(wrap);
    scrollThreadToBottom();
    return bubble;
  }

  function showPlain(box, text) {
    box.classList.add('whitespace-pre-wrap');
    show(box, text);
  }

  /** Like showPlain, but for assistant prose: renders as styled markdown instead of raw text. */
  function showMarkdown(box, text) {
    box.classList.remove('whitespace-pre-wrap', 'hidden');
    box.innerHTML = '';
    const el = document.createElement('div');
    renderMarkdown(el, text);
    box.appendChild(el);
  }

  function show(el, text) {
    el.classList.remove('hidden');
    el.textContent = text;
  }

  /* -------------------------------------------------------------------
   * History payload builder — prior turns of the active session, sent to
   * /api/master as `history` so follow-ups resolve with real context.
   * Route-kind turns (no free-text result) get a short synthetic summary
   * rather than being dropped, so the model still knows what happened.
   * ------------------------------------------------------------------- */
  function buildHistoryPayload(email, sessionId) {
    const session = History.get(email, sessionId);
    if (!session) return [];
    return session.messages
      .map(m => {
        if (m.role === 'user') return { role: 'user', content: m.content };
        if (m.kind === 'text' && m.content) return { role: 'assistant', content: m.content };
        if (m.kind === 'route' && m.meta) {
          return { role: 'assistant', content: `[Routed to ${m.meta.agent_id} → ${m.meta.endpoint}]` };
        }
        return null;
      })
      .filter(Boolean);
  }

  function persistAssistantMessage(email, msg) {
    if (!currentSessionId) return;
    if (!msg.id) msg.id = History.makeId();
    if (!msg.createdAt) msg.createdAt = new Date().toISOString();
    History.appendMessage(email, currentSessionId, msg);
    renderHistoryList(email);
  }

  async function runMasterAgent() {
    const input    = document.getElementById('master-input');
    const runBtn   = document.getElementById('master-run');
    const badge    = document.getElementById('master-model-badge');
    const message  = input.value.trim();
    if (!message) return;

    const email = getEmail();
    const settings = Settings.load(email);
    if (settings.routingMode === 'manual') {
      showPlain(appendAssistantBubble(), 'Routing mode is set to "Manual selection only" in Settings — pick an agent card below instead.');
      return;
    }

    // Master routing consumes the `master` quota bucket.
    const c = Quota.consume('master');
    if (!c.ok) {
      showPlain(appendAssistantBubble(), 'Daily Master Agent routing limit reached (' + Quota.limit('master') + '/day). Resets at midnight.');
      return;
    }

    // Start a session on the first message of a fresh chat.
    if (!currentSessionId) {
      const session = History.create(email, message);
      currentSessionId = session.id;
    }

    // Snapshot prior turns BEFORE this message is persisted, so it isn't duplicated.
    const priorHistory = buildHistoryPayload(email, currentSessionId);

    const userMsg = {
      id: History.makeId(), role: 'user', kind: 'text',
      content: message,
      meta: attachedFile ? { attachmentName: attachedFile.name } : {},
      createdAt: new Date().toISOString()
    };
    appendUserBubble(userMsg);
    History.appendMessage(email, currentSessionId, userMsg);
    renderHistoryList(email);

    input.value = '';
    autoGrow(input);

    const assistantBox = appendAssistantBubble();
    showPlain(assistantBox, 'Routing your request…');

    runBtn.disabled = true;

    let refunded = false;
    const refundOnce = () => { if (!refunded) { Quota.refund('master'); refunded = true; } };

    const attachmentInfo = attachedFile ? { name: attachedFile.name, type: attachedFile.type } : null;

    try {
      const res = await fetch('/api/master', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, attachment: attachmentInfo, history: priorHistory })
      });
      const data = await res.json();

      if (!res.ok) {
        refundOnce();
        const errText = 'Error: ' + (data.error || res.status) + (data.detail ? '\n' + data.detail : '');
        showPlain(assistantBox, errText);
        persistAssistantMessage(email, { role: 'assistant', kind: 'text', content: errText, meta: { isError: true } });
        return;
      }

      badge.textContent = (data.model_used || 'router') + (data.fallback_used ? ' (fallback)' : '');

      if (data.server_executed) {
        // chat / web — /api/master already ran this. Nothing left to execute.
        renderServerExecutedResult(assistantBox, data);
        persistAssistantMessage(email, {
          role: 'assistant', kind: 'text',
          content: data.result || null,
          meta: {
            source: data.source, model_used: data.model_used, fallback_used: data.fallback_used,
            fallback_note: data.fallback_note, agent_id: data.agent_id
          }
        });
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
        assistantBox.classList.add('font-mono');
        showPlain(assistantBox, text);

        const routeMsg = {
          id: History.makeId(), role: 'assistant', kind: 'route',
          content: null,
          meta: {
            agent_id: data.agent_id, endpoint: data.endpoint, params: data.params,
            reasoning: data.reasoning, fallback_note: data.fallback_note,
            executed: false, executionSummary: null
          },
          createdAt: new Date().toISOString()
        };
        persistAssistantMessage(email, routeMsg);

        // Only offer execution when the routed endpoint exists in the wrapper.
        if (PrexzyAPI.describe(data.endpoint)) {
          appendExecuteAction(assistantBox, routeMsg, email);
        }
      }
    } catch (e) {
      refundOnce();
      const errText = 'Request failed: ' + e.message;
      showPlain(assistantBox, errText);
      persistAssistantMessage(email, { role: 'assistant', kind: 'text', content: errText, meta: { isError: true } });
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
    if (data.agent_id === 'code') {
      // Raw code — leave as plain monospace text. Running it through the
      // markdown parser would mangle things like underscores in identifiers.
      answerEl.className = 'whitespace-pre-wrap font-mono text-xs text-slate-800 dark:text-slate-100 overflow-x-auto';
      answerEl.textContent = data.result;
    } else {
      answerEl.className = 'text-slate-800 dark:text-slate-100';
      renderMarkdown(answerEl, data.result);
    }

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

  /** Appends the "Execute on Prexzy" action row + wires the click handler, scoped to one bubble/message. */
  function appendExecuteAction(bubbleEl, routeMsg, email) {
    const actions = document.createElement('div');
    actions.className = 'mt-2 pt-2 border-t border-slate-200 dark:border-slate-700 flex items-center gap-2 font-sans';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'text-xs rounded-lg bg-emerald-600 text-white px-3 py-1.5 font-medium hover:bg-emerald-700 disabled:opacity-50';
    btn.textContent = '▶ Execute on Prexzy';

    const note = document.createElement('span');
    note.className = 'text-[11px] text-slate-400';
    note.textContent = "runs the routed endpoint via PrexzyAPI (consumes that agent's quota)";

    actions.append(btn, note);
    bubbleEl.appendChild(actions);

    btn.addEventListener('click', async () => {
      const endpoint = PrexzyAPI.describe(routeMsg.meta.endpoint);
      if (!endpoint) return;

      const settings = Settings.load(email);
      if (settings.confirmHeavy && endpoint.feature && HEAVY_FEATURES.has(endpoint.feature)) {
        const left = Quota.remaining(endpoint.feature);
        if (!confirm(`This will use 1 ${endpoint.feature} call (${left} left today). Continue?`)) return;
      }

      const resultArea = document.createElement('div');
      resultArea.className = 'mt-2 font-sans';
      bubbleEl.appendChild(resultArea);
      showPlain(resultArea, 'Executing ' + routeMsg.meta.endpoint + ' on Prexzy…');

      btn.disabled = true;
      try {
        const data = await PrexzyAPI.callResilient(routeMsg.meta.endpoint, routeMsg.meta.params);
        renderExecutionResult(resultArea, data);
        routeMsg.meta.executed = true;
        routeMsg.meta.executionSummary = summarizeForStorage(resultArea);
        History.updateMessage(email, currentSessionId, routeMsg.id, { meta: routeMsg.meta });
        actions.remove(); // one-shot — avoid double-spending quota on the same routed turn
      } catch (e) {
        showPlain(resultArea, (e.kind ? '[' + e.kind + '] ' : '') + e.message);
        btn.disabled = false;
      }
    });
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
      // Free-text results (e.g. image2html's underlying askgpt5 call) can
      // contain the same markdown a chat answer would — render accordingly.
      if (data._text) { showMarkdown(box, data._text); return; }
      if (data.result || data.response || data.answer || data.message) {
        showMarkdown(box, summarize(data, null));
        return;
      }
    }

    // Nothing recognizable — show raw JSON, but labeled as a fallback
    // rather than presented as if it were the intended output.
    showPlain(box, 'Unrecognized response shape — raw output:\n' + JSON.stringify(data, null, 2));
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

  /** Pulls a plain, JSON-serializable summary out of a rendered result area so it can survive a reload.
   *  Blob URLs (from binary Prexzy responses) don't survive navigation, so those are flagged rather
   *  than stored as if they'd still resolve. */
  function summarizeForStorage(resultArea) {
    const mediaEl = resultArea.querySelector('img, audio, video');
    const captionEl = resultArea.querySelector('div');
    const isBlob = !!(mediaEl && /^blob:/i.test(mediaEl.src || ''));
    return {
      caption: captionEl ? captionEl.textContent : resultArea.textContent,
      mediaUrl: mediaEl && !isBlob ? mediaEl.src : null,
      mediaKind: mediaEl ? (mediaEl.tagName === 'IMG' ? 'image' : mediaEl.tagName === 'AUDIO' ? 'audio' : 'video') : null,
      ephemeralMedia: isBlob
    };
  }

  /* -------------------------------------------------------------------
   * Rehydrating a stored message back into a bubble (session load / app boot).
   * ------------------------------------------------------------------- */
  function renderStoredMessage(message, email) {
    if (message.role === 'user') {
      appendUserBubble(message);
      return;
    }

    const box = appendAssistantBubble();

    if (message.kind === 'text') {
      if (message.meta && message.meta.isError) {
        showPlain(box, message.content);
        return;
      }
      renderServerExecutedResult(box, {
        result: message.content,
        source: message.meta.source,
        agent_id: message.meta.agent_id,
        fallback_note: message.meta.fallback_note
      });
      return;
    }

    // kind === 'route'
    box.classList.add('font-mono');
    const text =
      'agent: '     + message.meta.agent_id + '\n' +
      'endpoint: '  + message.meta.endpoint + '\n' +
      'params: '    + JSON.stringify(message.meta.params, null, 2) + '\n' +
      'reasoning: ' + message.meta.reasoning +
      (message.meta.fallback_note ? '\n\n⚠ ' + message.meta.fallback_note : '');
    showPlain(box, text);

    if (message.meta.executed && message.meta.executionSummary) {
      const s = message.meta.executionSummary;
      const resultArea = document.createElement('div');
      resultArea.className = 'mt-2 pt-2 border-t border-slate-200 dark:border-slate-700 font-sans';
      const captionEl = document.createElement('div');
      captionEl.className = 'text-slate-700 dark:text-slate-200 whitespace-pre-wrap';
      captionEl.textContent = s.caption || '';
      resultArea.appendChild(captionEl);
      if (s.mediaUrl) {
        const el = document.createElement(s.mediaKind === 'image' ? 'img' : s.mediaKind === 'audio' ? 'audio' : 'video');
        el.src = s.mediaUrl;
        if (s.mediaKind !== 'image') el.controls = true;
        el.className = 'max-w-full rounded-lg mt-2';
        resultArea.appendChild(el);
      } else if (s.ephemeralMedia) {
        const note = document.createElement('div');
        note.className = 'text-[11px] text-slate-400 mt-1';
        note.textContent = 'Media was generated this session and is no longer viewable after reload.';
        resultArea.appendChild(note);
      }
      box.appendChild(resultArea);
    } else if (PrexzyAPI.describe(message.meta.endpoint)) {
      appendExecuteAction(box, message, email);
    }
  }

  /* -------------------------------------------------------------------
   * History sidebar — list rendering, new/select/delete.
   * ------------------------------------------------------------------- */

  function renderHistoryList(email) {
    email = email || getEmail();
    const list = document.getElementById('history-list');
    if (!list) return;
    list.innerHTML = '';

    const sessions = email ? History.load(email) : [];
    if (!sessions.length) {
      const p = document.createElement('p');
      p.className = 'text-xs text-slate-400 text-center py-4';
      p.textContent = 'No past chats yet.';
      list.appendChild(p);
      return;
    }

    sessions.forEach(session => {
      const isActive = session.id === currentSessionId;
      const item = document.createElement('div');
      item.className = 'group flex items-center gap-1 rounded-lg px-2 py-2 cursor-pointer text-xs ' +
        (isActive
          ? 'bg-brand-50 dark:bg-slate-700 text-brand-700 dark:text-slate-100 font-medium'
          : 'hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300');

      const titleEl = document.createElement('span');
      titleEl.className = 'flex-1 truncate';
      titleEl.textContent = session.title || 'New chat';

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-500 px-1';
      delBtn.textContent = '✕';
      delBtn.setAttribute('aria-label', 'Delete chat');
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm('Delete this chat? This can\'t be undone.')) return;
        History.delete(email, session.id);
        if (session.id === currentSessionId) startNewChat();
        else renderHistoryList(email);
      });

      item.addEventListener('click', () => loadSession(email, session.id));
      item.append(titleEl, delBtn);
      list.appendChild(item);
    });
  }

  function loadSession(email, sessionId) {
    const session = History.get(email, sessionId);
    if (!session) return;
    currentSessionId = sessionId;
    clearThreadDOM();
    session.messages.forEach(m => renderStoredMessage(m, email));
    renderHistoryList(email);
    closeDrawer();
  }

  function startNewChat() {
    currentSessionId = null;
    clearThreadDOM();
    renderHistoryList();
  }

  /* -------------------------------------------------------------------
   * Drawer open/close.
   * ------------------------------------------------------------------- */
  function openDrawer() {
    const drawer = document.getElementById('history-drawer');
    const backdrop = document.getElementById('history-backdrop');
    if (!drawer || !backdrop) return;
    renderHistoryList();
    drawer.classList.remove('-translate-x-full');
    backdrop.classList.remove('hidden');
  }

  function closeDrawer() {
    const drawer = document.getElementById('history-drawer');
    const backdrop = document.getElementById('history-backdrop');
    if (!drawer || !backdrop) return;
    drawer.classList.add('-translate-x-full');
    backdrop.classList.add('hidden');
  }

  document.addEventListener('DOMContentLoaded', () => {
    const textarea    = document.getElementById('master-input');
    const attachBtn    = document.getElementById('master-attach');
    const fileInput     = document.getElementById('master-file-input');
    const attachChip   = document.getElementById('master-attachment');
    const attachName   = document.getElementById('master-attachment-name');
    const removeBtn     = document.getElementById('master-attachment-remove');

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

    // ---- History drawer wiring -----------------------------------------
    const toggleBtn  = document.getElementById('btn-history-toggle');
    const closeBtn   = document.getElementById('history-close');
    const backdrop   = document.getElementById('history-backdrop');
    const newChatBtn = document.getElementById('history-new-chat');

    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const drawer = document.getElementById('history-drawer');
        if (drawer.classList.contains('-translate-x-full')) openDrawer();
        else closeDrawer();
      });
    }
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    if (backdrop) backdrop.addEventListener('click', closeDrawer);
    if (newChatBtn) newChatBtn.addEventListener('click', () => { startNewChat(); closeDrawer(); });

    // Exposed for index.html's auth glue (enterApp / logout).
    window.MasterChat = {
      reset: startNewChat,
      closeDrawer
    };
  });

})();
