(function () {
  'use strict';

  var currentSessionId = null;
  var attachedFile = null;
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
  function el(id) { return document.getElementById(id); }

  function clearAttachment() {
    attachedFile = null;
    var inp = el('master-file-input');
    if (inp) inp.value = '';
    var box = el('master-attachment');
    if (box) box.classList.add('hidden');
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
    if (meta && meta.attachmentName) {
      var chip = document.createElement('div');
      chip.className = 'mt-1 text-[11px] text-brand-100';
      chip.textContent = '📎 ' + meta.attachmentName;
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

  function renderMarkdownInto(el, text) {
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
    el.classList.add('markdown-body');
    try {
      if (window.DOMPurify && typeof DOMPurify.sanitize === 'function') {
        el.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
      } else {
        el.innerHTML = html;
      }
    } catch (e2) {
      console.warn('[markdown] sanitize failed', e2);
      el.innerHTML = html;
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
      var note = '\n\n## Note (' + stamp + ')\n\n' + m.slice(0, 500) + '\n';
      await DocsClient.save('user_logs', String(existing || '') + note);
    } catch (_) {}
  }

  async function maybeLogSessionDigest(userMessage, assistantText) {
    assistantReplyCount += 1;
    if (assistantReplyCount % 5 !== 0) return;
    if (!window.DocsClient) return;
    var prefs = (window.Settings && email()) ? Settings.load(email()) : {};
    if (prefs.memoryEnabled === false) return;
    try {
      var res = await DocsClient.get('user_logs');
      var existing = (res && res.ok && res.content) ? res.content : '';
      var stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      var u = String(userMessage || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      var a = String(assistantText || '').replace(/\s+/g, ' ').trim().slice(0, 280);
      var block =
        '\n\n## Session log (' + stamp + ') — reply #' + assistantReplyCount + '\n\n' +
        '- User: ' + u + '\n' +
        '- Assistant: ' + a + '\n';
      await DocsClient.save('user_logs', String(existing || '') + block);
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
            OutputActions.attachMessageActions(b, {
              text: m.content || '',
              userPrompt: lastUserPrompt
            });
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
    if (b) b.classList.add('hidden');
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

  function buildHistoryPayload() {
    var em = email();
    if (!em || !currentSessionId || !window.History) return [];
    var s = History.get(em, currentSessionId);
    if (!s || !s.messages) return [];
    return s.messages.slice(-12).map(function (m) {
      return { role: m.role, content: String(m.content || '').slice(0, 2000) };
    });
  }

  async function runMaster() {
    var input = el('master-input');
    var message = (input && input.value || '').trim();
    if (!message && !attachedFile) return;
    if (!message && attachedFile) message = 'Please analyze this file: ' + attachedFile.name;

    var em = email();
    var prefs = (window.Settings && em) ? Settings.load(em) : {};
    var mcpTools = await loadMcpTools();

    if (window.History && em) {
      if (!currentSessionId) {
        var sess = History.create(em, message);
        currentSessionId = sess.id;
      }
      History.appendMessage(em, currentSessionId, {
        id: History.makeId(), role: 'user', kind: 'text', content: message,
        meta: attachedFile ? { attachmentName: attachedFile.name } : {},
        createdAt: Date.now()
      });
      renderHistoryList();
    }

    appendUser(message, attachedFile ? { attachmentName: attachedFile.name } : null);
    if (input) input.value = '';
    var assistantBox = appendAssistant();
    var runBtn = el('master-run');
    if (runBtn) runBtn.disabled = true;

    var attachment = null;
    try {
      if (attachedFile) attachment = await fileToAttachment(attachedFile);
    } catch (attErr) {
      assistantBox.textContent = String(attErr && attErr.message ? attErr.message : attErr);
      if (runBtn) runBtn.disabled = false;
      return;
    }

    var memory = await loadMemoryForRequest();
    var body = {
      message: message,
      history: buildHistoryPayload(),
      prefs: prefs || {},
      memory: memory,
      mcp_tools: mcpTools,
      attachment: attachment
    };

    try {
      var res = await fetch('/api/master', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
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
        var answer = document.createElement('div');
        answer.className = 'text-slate-800 dark:text-slate-100';
        renderMarkdownInto(answer, data.result);
        assistantBox.appendChild(answer);
        if (window.OutputActions) {
          if (OutputActions.enhanceCodeBlocks) OutputActions.enhanceCodeBlocks(answer);
          if (OutputActions.attachMessageActions) {
            OutputActions.attachMessageActions(assistantBox, {
              text: data.result,
              userPrompt: message
            });
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
          OutputActions.attachMessageActions(assistantBox, {
            text: preText(data),
            userPrompt: message
          });
        }
      }

      if (data.fallback_note) {
        var note = document.createElement('div');
        note.className = 'mt-2 text-[11px] text-amber-600';
        note.textContent = data.fallback_note;
        assistantBox.appendChild(note);
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
      } else if (window.PrexzyAPI) {
        var r = await PrexzyAPI.runRoute(data);
        var a = document.createElement('div');
        a.className = 'mt-2 text-sm';
        renderMarkdownInto(a, typeof r === 'string' ? r : JSON.stringify(r, null, 2));
        box.appendChild(a);
      } else {
        throw new Error('No executor for ' + data.agent_id);
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
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runMaster(); }
      });
    }
    var attach = el('master-attach');
    var fileInput = el('master-file-input');
    if (attach && fileInput) {
      fileInput.setAttribute('accept', 'image/*,.pdf,.txt,.md,.csv,.json,.js,.ts,.py,.html,.css,.xml,audio/*,.doc,.docx,application/pdf,text/plain,text/markdown');
      attach.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return;
        attachedFile = f;
        var name = el('master-attachment-name');
        var box = el('master-attachment');
        if (name) name.textContent = f.name;
        if (box) box.classList.remove('hidden');
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
