(function () {
  'use strict';

  var currentSessionId = null;
  var attachedFile = null;
  var EXECUTABLE = { image: 1, video: 1, music: 1, tts: 1, code: 1, html2image: 1, mcp: 1, browse: 1 };

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
    (s.messages || []).forEach(function (m) {
      if (m.role === 'user') appendUser(m.content || '', m.meta);
      else {
        var b = appendAssistant();
        b.textContent = '';
        var pre = document.createElement('pre');
        pre.className = 'whitespace-pre-wrap font-mono text-xs m-0';
        pre.textContent = m.content || '';
        b.appendChild(pre);
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

    var body = {
      message: message,
      history: buildHistoryPayload(),
      prefs: prefs || {},
      mcp_tools: mcpTools
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
        MasterThinking.inject(assistantBox, data.thinking, null);
      }

      if (data.server_executed && data.result) {
        var answer = document.createElement('div');
        answer.className = 'whitespace-pre-wrap text-slate-800 dark:text-slate-100';
        answer.textContent = String(data.result);
        assistantBox.appendChild(answer);
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
          btn.addEventListener('click', function () {
            executeRoute(data, assistantBox, btn);
          });
          actions.appendChild(btn);
          assistantBox.appendChild(actions);
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
        area.className = 'mt-2 whitespace-pre-wrap text-sm';
        area.textContent = (out && out.result != null) ? String(out.result) : JSON.stringify(out, null, 2);
        box.appendChild(area);
      } else if (window.PrexzyAPI) {
        var r = await PrexzyAPI.runRoute(data);
        var a = document.createElement('div');
        a.className = 'mt-2 whitespace-pre-wrap text-sm';
        a.textContent = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
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
  }

  function startNewChatPublic() { startNewChat(); }
  function closeDrawerPublic() { closeDrawer(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  window.MasterChat = { reset: startNewChatPublic, closeDrawer: closeDrawerPublic };
})();
