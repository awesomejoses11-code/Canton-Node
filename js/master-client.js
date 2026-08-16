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
      if (window.Auth && typeof Auth.token === 'function') return Auth.token() || '';
      if (window.Auth && Auth.current) {
        var u = Auth.current();
        if (u && u.token) return String(u.token);
      }
    } catch (_) {}
    return '';
  }
  function el(id) { return document.getElementById(id); }

  function renderAttachmentBar() {
    var box = el('master-attachment');
    var name = el('master-attachment-name');
    if (!box) return;
    if (!attachedFiles.length) {
      box.classList.add('hidden');
      if (name) name.textContent = '';
      return;
    }
    box.classList.remove('hidden');
    if (name) {
      if (attachedFiles.length === 1) name.textContent = attachedFiles[0].name;
      else name.textContent = attachedFiles.length + ' files: ' + attachedFiles.map(function (f) { return f.name; }).join(', ');
    }
  }

  function clearAttachment() {
    attachedFiles = [];
    var inp = el('master-file-input');
    if (inp) inp.value = '';
    renderAttachmentBar();
  }

  function addFiles(fileList) {
    if (!fileList || !fileList.length) return;
    var added = 0;
    for (var i = 0; i < fileList.length; i++) {
      if (attachedFiles.length >= MAX_ATTACH_COUNT) break;
      var f = fileList[i];
      if (!f) continue;
      if (f.size > MAX_ATTACH_BYTES) {
        console.warn('[attach] skip oversized', f.name);
        continue;
      }
      attachedFiles.push(f);
      added++;
    }
    renderAttachmentBar();
    return added;
  }

  function fileFromClipboardItem(item) {
    return new Promise(function (resolve) {
      if (!item || !item.type || item.type.indexOf('image/') !== 0) return resolve(null);
      var blob = item.getAsFile ? item.getAsFile() : null;
      if (!blob) return resolve(null);
      var ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      var name = 'paste-' + Date.now() + '.' + ext;
      try {
        resolve(new File([blob], name, { type: blob.type || 'image/png' }));
      } catch (_) {
        blob.name = name;
        resolve(blob);
      }
    });
  }

  function appendUser(text, meta) {
    var thread = el('master-thread');
    var empty = el('master-thread-empty');
    if (empty) empty.remove();
    var wrap = document.createElement('div');
    wrap.className = 'flex justify-end';
    var b = document.createElement('div');
    b.className = 'max-w-[92%] rounded-2xl bg-brand-600 text-white text-sm px-3 py-2 whitespace-pre-wrap';
    b.textContent = text;
    if (meta && (meta.attachmentName || meta.attachmentNames)) {
      var chip = document.createElement('div');
      chip.className = 'mt-1 text-[11px] text-brand-100';
      var labels = meta.attachmentNames || [meta.attachmentName];
      chip.textContent = '📎 ' + labels.join(', ');
      b.appendChild(chip);
    }
    wrap.appendChild(b);
    thread.appendChild(wrap);
    thread.scrollTop = thread.scrollHeight;
    return b;
  }

  function appendAssistant() {
    var thread = el('master-thread');
    var wrap = document.createElement('div');
    wrap.className = 'flex justify-start w-full';
    var b = document.createElement('div');
    b.className = 'assistant-bubble w-full rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs sm:text-sm px-3 py-2';
    b.textContent = 'Routing your request…';
    wrap.appendChild(b);
    thread.appendChild(wrap);
    thread.scrollTop = thread.scrollHeight;
    return b;
  }

  function simpleMarkdownToHtml(src) {
    var s = String(src == null ? '' : src);
    s = s.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
    s = s.replace(/```([\s\S]*?)```/g, function (_, code) {
      return '<pre><code>' + code.replace(/^\n+|\n+$/g, '') + '</code></pre>';
    });
    s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/(?:^|\n)((?:- .+(?:\n|$))+)/g, function (block) {
      var items = block.trim().split(/\n/).map(function (line) {
        return '<li>' + line.replace(/^- /, '') + '</li>';
      }).join('');
      return '\n<ul>' + items + '</ul>\n';
    });
    s = s.replace(/\n\n+/g, '</p><p>');
    s = s.replace(/\n/g, '<br>\n');
    s = '<p>' + s + '</p>';
    s = s.replace(/<p>\s*(<h[1-3]>)/g, '$1');
    s = s.replace(/(<\/h[1-3]>)\s*<\/p>/g, '$1');
    s = s.replace(/<p>\s*(<ul>)/g, '$1');
    s = s.replace(/(<\/ul>)\s*<\/p>/g, '$1');
    s = s.replace(/<p>\s*(<pre>)/g, '$1');
    s = s.replace(/(<\/pre>)\s*<\/p>/g, '$1');
    s = s.replace(/<p>\s*<\/p>/g, '');
    return s;
  }

  function renderMarkdownInto(target, text) {
    var raw = String(text == null ? '' : text);
    raw = raw.replace(/^#{6,}\s*$/gm, '');
    var html = null;
    try {
      var m = window.marked;
      if (m && typeof m.parse === 'function') html = m.parse(raw, { breaks: true });
      else if (m && m.marked && typeof m.marked.parse === 'function') html = m.marked.parse(raw, { breaks: true });
      else if (typeof m === 'function') html = m(raw);
    } catch (e) {
      console.warn('[markdown] marked failed', e);
      html = null;
    }
    if (!html) html = simpleMarkdownToHtml(raw);
    target.classList.add('markdown-body');
    try {
      if (window.DOMPurify && typeof DOMPurify.sanitize === 'function') {
        target.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
      } else {
        target.innerHTML = html;
      }
    } catch (e2) {
      console.warn('[markdown] sanitize failed', e2);
      target.innerHTML = html;
    }
  }

  async function loadMemoryForRequest() {
    var em = email();
    var prefs = (window.Settings && em) ? Settings.load(em) : {};
    if (!prefs.memoryEnabled) return null;
    if (!window.DocsClient) return { enabled: true, reference: '', user_logs: '' };
    try {
      var res = await DocsClient.list();
      if (!res || !res.ok || !res.docs) return { enabled: true, reference: '', user_logs: '' };
      return {
        enabled: true,
        reference: String(res.docs.reference || '').slice(0, 6000),
        user_logs: String(res.docs.user_logs || '').slice(0, 6000)
      };
    } catch (_) {
      return { enabled: true, reference: '', user_logs: '' };
    }
  }

  async function maybeAppendMemoryNote(userMessage) {
    var m = String(userMessage || '');
    if (!/\b(remember (this|that|to)|note that|save (this|that) (to|in) memory|add to (my )?memory|don'?t forget)\b/i.test(m)) return;
    if (!window.DocsClient) return;
    var prefs = (window.Settings && email()) ? Settings.load(email()) : {};
    if (prefs.memoryEnabled === false) return;
    try {
      var res = await DocsClient.get('user_logs');
      var existing = (res && res.ok && res.content) ? res.content : '';
      var stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      var note = '\n\n## Preference (' + stamp + ')\n- ' + m.slice(0, 400) + '\n';
      var next = String(existing || '') + note;
      if (next.length > 12000) next = next.slice(-10000);
      await DocsClient.save('user_logs', next);
    } catch (_) {}
  }

  async function maybeLogSessionDigest(userMessage, assistantText) {
    assistantReplyCount += 1;
    if (assistantReplyCount % 8 !== 0) return;
    if (!window.DocsClient) return;
    var prefs = (window.Settings && email()) ? Settings.load(email()) : {};
    if (prefs.memoryEnabled === false) return;
    try {
      var res = await DocsClient.get('user_logs');
      var existing = (res && res.ok && res.content) ? res.content : '';
      var stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      var u = String(userMessage || '').replace(/\s+/g, ' ').trim();
      var topic = u.slice(0, 80);
      if (/\b(video|image|music|tts)\b/i.test(u)) topic = 'media: ' + topic;
      else if (/\b(price|crypto|btc|eth)\b/i.test(u)) topic = 'crypto: ' + topic;
      else if (/\b(code|bug|error|fix)\b/i.test(u)) topic = 'dev: ' + topic;
      else topic = 'chat: ' + topic;
      var block = '\n\n## ' + stamp + '\n- Topic: ' + topic + '\n- Turns since last note: 8\n';
      var next = String(existing || '') + block;
      if (next.length > 12000) next = next.slice(-10000);
      await DocsClient.save('user_logs', next);
    } catch (_) {}
  }

  function renderHistoryList() {
    var list = el('history-list');
    if (!list || !window.History) return;
    var em = email();
    var sessions = em ? History.load(em) : [];
    list.innerHTML = '';
    sessions.forEach(function (s) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'w-full text-left text-xs px-2 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 truncate';
      item.textContent = s.title || 'Chat';
      item.addEventListener('click', function () { loadSession(s.id); });
      list.appendChild(item);
    });
  }

  function loadSession(id) {
    var em = email();
    if (!em || !window.History) return;
    var s = History.get(em, id);
    if (!s) return;
    currentSessionId = id;
    var thread = el('master-thread');
    thread.innerHTML = '';
    var lastUserPrompt = '';
    (s.messages || []).forEach(function (m) {
      if (m.role === 'user') {
        lastUserPrompt = m.content || '';
        appendUser(m.content || '', m.meta);
      } else {
        var b = appendAssistant();
        b.textContent = '';
        var ans = document.createElement('div');
        renderMarkdownInto(ans, m.content || '');
        b.appendChild(ans);
        if (window.OutputActions) {
          if (OutputActions.enhanceCodeBlocks) OutputActions.enhanceCodeBlocks(ans);
          if (OutputActions.attachMessageActions) {
            OutputActions.attachMessageActions(b, { text: m.content || '', userPrompt: lastUserPrompt });
          }
        }
      }
    });
    if (!(s.messages || []).length) {
      thread.innerHTML = '<p id="master-thread-empty" class="text-xs text-slate-400 text-center py-6">No messages yet — start a conversation below.</p>';
    }
    closeDrawer();
  }

  function startNewChat() {
    currentSessionId = null;
    var thread = el('master-thread');
    thread.innerHTML = '<p id="master-thread-empty" class="text-xs text-slate-400 text-center py-6">No messages yet — start a conversation below.</p>';
    clearAttachment();
    renderHistoryList();
  }

  function openDrawer() {
    var d = el('history-drawer');
    var b = el('history-backdrop');
    if (d) d.classList.remove('-translate-x-full');
    if (b) b.classList.remove('hidden');
    renderHistoryList();
  }
  function closeDrawer() {
    var d = el('history-drawer');
    var b = el('history-backdrop');
    if (d) d.classList.add('-translate-x-full');
    if (b) b.classList.add('hidden');
  }

  async function loadMcpTools() {
    var em = email();
    if (!window.MCPClient || !em) return [];
    try {
      var tools = await MCPClient.getEnabledTools(em);
      return (tools || []).slice(0, 40).map(function (t) {
        return {
          qualified: t.qualified, serverId: t.serverId, serverName: t.serverName,
          name: t.name, description: String(t.description || '').slice(0, 200)
        };
      });
    } catch (e) { return []; }
  }

  function loadMcpServers() {
    var em = email();
    if (!window.MCPClient || !em) return [];
    try {
      return MCPClient.listServers(em)
        .filter(function (s) { return s && s.enabled !== false && s.url; })
        .slice(0, 20)
        .map(function (s) {
          return {
            id: s.id, name: s.name, url: s.url,
            enabled: s.enabled !== false,
            toolCount: (s.lastTools && s.lastTools.length) || 0,
            lastError: s.lastError || null
          };
        });
    } catch (_) {
      return [];
    }
  }

  function buildHistoryPayload() {
    var em = email();
    if (!em || !currentSessionId || !window.History) return [];
    var s = History.get(em, currentSessionId);
    if (!s || !s.messages) return [];
    return s.messages.slice(-12).map(function (m) {
      return { role: m.role, content: String(m.content || '').slice(0, 2000) };
    });
  }

  /** Read SSE from /api/master and invoke handlers. */
  async function consumeSse(response, handlers) {
    handlers = handlers || {};
    var reader = response.body && response.body.getReader ? response.body.getReader() : null;
    if (!reader) {
      var t = await response.text();
      throw new Error(t || 'Empty stream');
    }
    var decoder = new TextDecoder();
    var buffer = '';
    var eventName = 'message';
    var dataLines = [];

    function flushEvent() {
      if (!dataLines.length) { eventName = 'message'; return; }
      var dataStr = dataLines.join('\n');
      dataLines = [];
      var name = eventName;
      eventName = 'message';
      var payload = null;
      try { payload = JSON.parse(dataStr); } catch (_) { payload = { raw: dataStr }; }
      if (name === 'meta' && handlers.onMeta) handlers.onMeta(payload);
      else if (name === 'delta' && handlers.onDelta) handlers.onDelta(payload);
      else if (name === 'done' && handlers.onDone) handlers.onDone(payload);
      else if (name === 'error' && handlers.onError) handlers.onError(payload);
    }

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var parts = buffer.split('\n');
      buffer = parts.pop() || '';
      for (var i = 0; i < parts.length; i++) {
        var line = parts[i];
        if (line === '') { flushEvent(); continue; }
        if (line.charAt(0) === ':') continue;
        if (line.indexOf('event:') === 0) {
          eventName = line.slice(6).trim();
        } else if (line.indexOf('data:') === 0) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
    }
    flushEvent();
  }

  async function runMaster() {
    var input = el('master-input');
    var message = (input && input.value || '').trim();
    if (!message && !attachedFiles.length) return;
    if (!message && attachedFiles.length) {
      message = attachedFiles.length === 1
        ? ('Please analyze this file: ' + attachedFiles[0].name)
        : ('Please analyze these files: ' + attachedFiles.map(function (f) { return f.name; }).join(', '));
    }

    var em = email();
    var prefs = (window.Settings && em) ? Settings.load(em) : {};
    var mcpTools = await loadMcpTools();
    var mcpServers = loadMcpServers();
    var attachNames = attachedFiles.map(function (f) { return f.name; });

    if (window.History && em) {
      if (!currentSessionId) {
        var sess = History.create(em, message);
        currentSessionId = sess.id;
      }
      History.appendMessage(em, currentSessionId, {
        id: History.makeId(), role: 'user', kind: 'text', content: message,
        meta: attachNames.length ? { attachmentNames: attachNames, attachmentName: attachNames[0] } : {},
        createdAt: Date.now()
      });
      renderHistoryList();
    }

    appendUser(message, attachNames.length ? { attachmentNames: attachNames } : null);
    if (input) input.value = '';
    var assistantBox = appendAssistant();
    var runBtn = el('master-run');
    if (runBtn) runBtn.disabled = true;

    var attachment = null;
    var attachments = [];
    try {
      for (var ai = 0; ai < attachedFiles.length; ai++) {
        var one = await fileToAttachment(attachedFiles[ai]);
        if (one) attachments.push(one);
      }
      var imageAtt = null;
      var textBits = [];
      for (var bi = 0; bi < attachments.length; bi++) {
        if (attachments[bi].kind === 'image' && !imageAtt) imageAtt = attachments[bi];
        else if (attachments[bi].kind === 'text' && attachments[bi].text) {
          textBits.push('--- ' + attachments[bi].name + ' ---\n' + attachments[bi].text);
        }
      }
      if (textBits.length) message = message + '\n\n' + textBits.join('\n\n');
      attachment = imageAtt || attachments[0] || null;
    } catch (attErr) {
      assistantBox.textContent = String(attErr && attErr.message ? attErr.message : attErr);
      if (runBtn) runBtn.disabled = false;
      return;
    }

    // Streaming only for pure chat (no image attachment analysis)
    var useStream = !attachment || attachment.kind !== 'image';

    var memory = await loadMemoryForRequest();
    var body = {
      message: message,
      history: buildHistoryPayload(),
      prefs: prefs || {},
      memory: memory,
      token: sessionToken(),
      mcp_tools: mcpTools,
      mcp_servers: mcpServers,
      attachment: attachment,
      attachments: attachments,
      stream: useStream
    };

    try {
      var res = await fetch('/api/master', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: useStream ? 'text/event-stream, application/json' : 'application/json' },
        body: JSON.stringify(body)
      });

      var ct = String(res.headers.get('content-type') || '').toLowerCase();
      var isSse = ct.indexOf('text/event-stream') !== -1;

      if (isSse) {
        assistantBox.textContent = '';
        var answer = document.createElement('div');
        answer.className = 'text-slate-800 dark:text-slate-100 markdown-body';
        assistantBox.appendChild(answer);

        var accumulated = '';
        var lastPaint = 0;
        var meta = null;
        var donePayload = null;

        function paint(force) {
          var now = Date.now();
          if (!force && now - lastPaint < 48) return;
          lastPaint = now;
          // Progressive: plain text during stream for speed; full markdown on done
          answer.textContent = accumulated;
          var thread = el('master-thread');
          if (thread) thread.scrollTop = thread.scrollHeight;
        }

        await consumeSse(res, {
          onMeta: function (p) {
            meta = p;
            if (p && p.thinking && window.MasterThinking && MasterThinking.inject) {
              MasterThinking.inject(assistantBox, p.thinking, null);
            }
          },
          onDelta: function (p) {
            if (p && typeof p.text === 'string') {
              accumulated += p.text;
              paint(false);
            }
          },
          onDone: function (p) {
            donePayload = p;
            if (p && p.result) accumulated = p.result;
            paint(true);
            renderMarkdownInto(answer, accumulated);
            if (window.OutputActions) {
              if (OutputActions.enhanceCodeBlocks) OutputActions.enhanceCodeBlocks(answer);
              if (OutputActions.attachMessageActions) {
                OutputActions.attachMessageActions(assistantBox, { text: accumulated, userPrompt: message });
              }
            }
          },
          onError: function (p) {
            var msg = (p && p.error) ? p.error : 'Stream error';
            if (!accumulated) answer.textContent = msg;
            else answer.textContent = accumulated + '\n\n[' + msg + ']';
          }
        });

        if (!donePayload && accumulated) {
          renderMarkdownInto(answer, accumulated);
        }

        var finalText = (donePayload && donePayload.result) || accumulated || '';
        if (window.History && em && currentSessionId && finalText) {
          History.appendMessage(em, currentSessionId, {
            id: History.makeId(), role: 'assistant', kind: 'text',
            content: finalText,
            meta: donePayload || meta || {}, createdAt: Date.now()
          });
          renderHistoryList();
        }
        maybeAppendMemoryNote(message);
        maybeLogSessionDigest(message, finalText);
        clearAttachment();
        return;
      }

      // JSON fallback (attachments / non-stream routes)
      var data = await res.json().catch(function () { return null; });
      if (!res.ok || !data) {
        assistantBox.textContent = (data && data.error) ? data.error : ('Request failed (' + res.status + ')');
        return;
      }

      assistantBox.textContent = '';
      if (data.thinking && window.MasterThinking && MasterThinking.inject) {
        var dur = (typeof data.thinking_ms === 'number') ? data.thinking_ms : null;
        MasterThinking.inject(assistantBox, data.thinking, dur);
      }

      if (data.server_executed && data.result) {
        var ans2 = document.createElement('div');
        ans2.className = 'text-slate-800 dark:text-slate-100';
        renderMarkdownInto(ans2, data.result);
        assistantBox.appendChild(ans2);
        if (window.OutputActions) {
          if (OutputActions.enhanceCodeBlocks) OutputActions.enhanceCodeBlocks(ans2);
          if (OutputActions.attachMessageActions) {
            OutputActions.attachMessageActions(assistantBox, { text: data.result, userPrompt: message });
          }
        }
      } else {
        var pre = document.createElement('pre');
        pre.className = 'whitespace-pre-wrap font-mono text-xs m-0';
        pre.textContent =
          'agent: ' + (data.agent_id || '') + '\n' +
          'endpoint: ' + (data.endpoint || '') + '\n' +
          'params: ' + JSON.stringify(data.params || {}, null, 2) + '\n' +
          'reasoning: ' + (data.reasoning || '');
        assistantBox.appendChild(pre);

        if (EXECUTABLE[data.agent_id] || data.agent_id === 'mcp') {
          var actions = document.createElement('div');
          actions.className = 'mt-2 pt-2 border-t border-slate-200 dark:border-slate-700 flex gap-2';
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'text-xs rounded-lg bg-violet-600 text-white px-3 py-1.5 font-medium';
          btn.textContent = data.agent_id === 'mcp' ? 'Execute MCP' : 'Execute';
          btn.addEventListener('click', function () { executeRoute(data, assistantBox, btn); });
          actions.appendChild(btn);
          assistantBox.appendChild(actions);
        }
        if (window.OutputActions && OutputActions.attachMessageActions) {
          OutputActions.attachMessageActions(assistantBox, { text: preText(data), userPrompt: message });
        }
      }

      if (window.History && em && currentSessionId) {
        History.appendMessage(em, currentSessionId, {
          id: History.makeId(), role: 'assistant', kind: data.server_executed ? 'text' : 'route',
          content: data.result || preText(data),
          meta: data, createdAt: Date.now()
        });
        renderHistoryList();
      }
      maybeAppendMemoryNote(message);
      maybeLogSessionDigest(message, data.result || preText(data));
      clearAttachment();
    } catch (err) {
      assistantBox.textContent = String(err && err.message ? err.message : err);
    } finally {
      if (runBtn) runBtn.disabled = false;
    }
  }

  function preText(data) {
    return 'agent: ' + (data.agent_id || '') + '\nendpoint: ' + (data.endpoint || '');
  }

  async function executeRoute(data, box, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      if (data.agent_id === 'mcp' && window.MCPClient) {
        var servers = MCPClient.listServers(email());
        var sid = data.mcp_server_id || (data.params && data.params.serverId);
        var tool = data.mcp_tool || (data.params && data.params.tool);
        var server = servers.find(function (s) { return s.id === sid; });
        if (!server) throw new Error('MCP server not found');
        var args = Object.assign({}, data.params || {});
        delete args.serverId; delete args.tool; delete args.name;
        var out = await MCPClient.callTool(server, tool, args);
        var area = document.createElement('div');
        area.className = 'mt-2 text-sm';
        var raw = (out && out.result != null) ? out.result : out;
        if (window.MCPFormat && MCPFormat.formatMcpResult) {
          renderMarkdownInto(area, MCPFormat.formatMcpResult(raw));
        } else {
          area.textContent = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
        }
        box.appendChild(area);
      } else if (window.PrexzyAPI && typeof PrexzyAPI.runRoute === 'function') {
        var r = await PrexzyAPI.runRoute(data, { loadingEl: box });
        var a = document.createElement('div');
        a.className = 'mt-2 text-sm space-y-2';
        var url = r && (r.url || r.video_url || r.image_url);
        if (url && data.agent_id === 'video') {
          var vid = document.createElement('video');
          vid.controls = true; vid.playsInline = true;
          vid.className = 'w-full rounded-lg max-h-80 bg-black';
          vid.src = url;
          a.appendChild(vid);
        } else if (url && (data.agent_id === 'image' || data.agent_id === 'html2image')) {
          var img = document.createElement('img');
          img.src = url;
          img.alt = (data.params && data.params.prompt) || 'generated';
          img.className = 'w-full rounded-lg max-h-96 object-contain';
          a.appendChild(img);
        } else if (typeof r === 'string') {
          renderMarkdownInto(a, r);
        } else if (r && r.url) {
          a.innerHTML = '<a class="text-brand-600 underline" href="' + r.url + '" target="_blank" rel="noopener">Open result</a>';
        } else {
          renderMarkdownInto(a, '```json\n' + JSON.stringify(r, null, 2).slice(0, 2000) + '\n```');
        }
        box.appendChild(a);
      } else {
        throw new Error('PrexzyAPI.runRoute is not a function — hard-refresh to load the latest api.js');
      }
    } catch (e) {
      var err = document.createElement('div');
      err.className = 'mt-2 text-rose-600 text-xs';
      err.textContent = String(e && e.message ? e.message : e);
      box.appendChild(err);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = data.agent_id === 'mcp' ? 'Execute MCP' : 'Execute'; }
    }
  }

  function wire() {
    var run = el('master-run');
    if (run) run.addEventListener('click', runMaster);
    var input = el('master-input');
    if (input) {
      input.addEventListener('paste', function (e) {
        var cd = e.clipboardData || window.clipboardData;
        if (!cd || !cd.items) return;
        var imageItems = [];
        for (var i = 0; i < cd.items.length; i++) {
          if (cd.items[i].type && cd.items[i].type.indexOf('image/') === 0) imageItems.push(cd.items[i]);
        }
        if (!imageItems.length) return;
        e.preventDefault();
        Promise.all(imageItems.map(fileFromClipboardItem)).then(function (files) {
          var real = files.filter(Boolean);
          if (real.length) addFiles(real);
        });
      });
    }
    var attach = el('master-attach');
    var fileInput = el('master-file-input');
    if (attach && fileInput) {
      fileInput.setAttribute('accept', 'image/*,image/jpeg,image/png,image/webp,image/gif,application/pdf,text/*,.md,.csv,.json,.txt');
      fileInput.setAttribute('multiple', 'multiple');
      fileInput.multiple = true;
      fileInput.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;';
      fileInput.classList.remove('hidden');
      fileInput.removeAttribute('capture');
      attach.addEventListener('click', function (ev) {
        ev.preventDefault();
        try { fileInput.value = ''; } catch (_) {}
        fileInput.click();
      });
      fileInput.addEventListener('change', function () {
        var list = fileInput.files;
        if (!list || !list.length) return;
        addFiles(list);
      });
    }
    var rem = el('master-attachment-remove');
    if (rem) rem.addEventListener('click', clearAttachment);

    var toggle = el('btn-history-toggle');
    if (toggle) toggle.addEventListener('click', openDrawer);
    var close = el('history-close');
    if (close) close.addEventListener('click', closeDrawer);
    var backdrop = el('history-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeDrawer);
    var neu = el('history-new-chat');
    if (neu) neu.addEventListener('click', function () { startNewChat(); closeDrawer(); });

    renderHistoryList();
    var em0 = email();
    if (em0 && window.History && History.syncFromServer) {
      History.syncFromServer(em0).then(function () { renderHistoryList(); }).catch(function () {});
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.MasterChat = { reset: startNewChat, closeDrawer: closeDrawer };
})();
