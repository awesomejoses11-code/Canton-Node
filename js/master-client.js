(function () {
  'use strict';

  let currentSessionId = null;
  let attachedFile = null;

  const HEAVY_FEATURES = new Set(['image', 'music', 'video']);
  const EXECUTABLE_AGENTS = new Set(['image', 'video', 'music', 'tts', 'code', 'html2image', 'mcp']);

  const SOURCE_LABELS = {
    'openrouter':        function (d) { return 'OpenRouter — ' + (d.model_used || 'fallback model'); },
    'openrouter-online': function (d) { return 'OpenRouter — with live web search (' + (d.model_used || 'fallback model') + ')'; },
    'vinci':             function (d) { return 'Vinci — ' + (d.model_used || 'forte'); },
    'llm':               function (d) { return (d.model_used || 'LLM'); },
    'master-capabilities': function () { return 'Master Agent — tools & quotas'; },
    'mcp':               function (d) { return 'MCP — ' + (d.server_name || d.tool || 'external tool'); }
  };

  function getPrexzyAPI() {
    return (typeof window !== 'undefined' && window.PrexzyAPI) ? window.PrexzyAPI : null;
  }

  function getEmail() {
    const u = Auth.current();
    return u ? u.email : null;
  }

  async function loadMcpToolsForMaster(email) {
    if (!window.MCPClient || !email) return [];
    try {
      const tools = await MCPClient.getEnabledTools(email);
      return (tools || []).slice(0, 40).map(function (t) {
        return {
          qualified: t.qualified,
          serverId: t.serverId,
          serverName: t.serverName,
          name: t.name,
          description: String(t.description || '').slice(0, 200),
          inputSchema: t.inputSchema || { type: 'object' }
        };
      });
    } catch (e) {
      console.warn('[master] MCP tools load failed', e);
      return [];
    }
  }

  /**
   * CoinGecko MCP `execute` requires { code: string } — a TS/JS function:
   *   async function run(client) { ... }
   * When the router only picked the tool, synthesize code from the user prompt.
   */
  function extractCoinQuery(prompt) {
    var p = String(prompt || '');
    // Prefer quoted names, then “price of X”, then residual tokens
    var m =
      p.match(/["']([^"']{2,40})["']/) ||
      p.match(/\b(?:price|value|worth|market\s*cap)\s+of\s+([A-Za-z0-9][A-Za-z0-9 .\-]{1,40}?)(?:\s*[,?.!]|$|\s+using|\s+on|\s+via)/i) ||
      p.match(/\b([A-Za-z][A-Za-z0-9]{1,30})\s+(?:price|coin|token)\b/i);
    var raw = m ? m[1] : p;
    raw = String(raw)
      .replace(/\busing\s+coingecko\b/ig, '')
      .replace(/\bcoingecko\b/ig, '')
      .replace(/\b(what'?s|what is|tell me|please|the|current|usd|price|of|coin|token)\b/ig, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!raw || raw.length < 2) raw = 'bitcoin';
    return raw.slice(0, 60);
  }

  function buildCoinGeckoExecuteCode(userPrompt) {
    var q = extractCoinQuery(userPrompt);
    var qLit = JSON.stringify(q);
    // Search → resolve id → simple.price (works for names like "Canton coin")
    return [
      'async function run(client) {',
      '  const query = ' + qLit + ';',
      '  let id = query.toLowerCase().replace(/\\s+/g, "-");',
      '  try {',
      '    const found = await client.search.get({ query });',
      '    if (found && found.coins && found.coins.length) id = found.coins[0].id;',
      '  } catch (e) { /* fall back to slug */ }',
      '  const price = await client.simple.price.get({',
      '    ids: id,',
      '    vs_currencies: "usd",',
      '    include_24hr_change: true,',
      '    include_market_cap: true',
      '  });',
      '  return { query, id, price };',
      '}'
    ].join('\n');
  }

  function ensureMcpArguments(toolName, args, userPrompt, serverName) {
    var out = Object.assign({}, args || {});
    var name = String(toolName || '').toLowerCase();
    var isCoinGecko = /coingecko/i.test(serverName || '');

    if (name === 'execute' && !out.code) {
      if (isCoinGecko || /price|coin|token|crypto|btc|eth|market/i.test(userPrompt || '')) {
        out.code = buildCoinGeckoExecuteCode(userPrompt);
        out.intent = String(userPrompt || 'crypto price lookup').slice(0, 200);
      } else {
        out.code =
          'async function run(client) {\n' +
          '  // TODO: implement based on: ' + JSON.stringify(String(userPrompt || '').slice(0, 120)) + '\n' +
          '  return { error: "No code generated for this request" };\n' +
          '}';
        out.intent = String(userPrompt || '').slice(0, 200);
      }
    }

    if (name === 'search_docs') {
      if (!out.query) out.query = String(userPrompt || 'API usage').slice(0, 200);
      if (!out.language) out.language = 'typescript';
    }

    return out;
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

  function renderMarkdown(el, text) {
    if (window.marked) {
      const raw = marked.parse(String(text == null ? '' : text), { breaks: true, gfm: true });
      el.innerHTML = window.DOMPurify ? DOMPurify.sanitize(raw) : raw;
      el.classList.add('markdown-body');
      if (window.OutputActions) window.OutputActions.enhanceCodeBlocks(el);
    } else {
      el.classList.add('whitespace-pre-wrap');
      el.textContent = text;
    }
  }

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
    wrap.className = 'user-bubble-wrap flex justify-end';
    const bubble = document.createElement('div');
    bubble.className = 'max-w-[92%] sm:max-w-[85%] rounded-2xl bg-brand-600 text-white text-sm px-3 py-2 whitespace-pre-wrap';
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

  function appendAssistantBubble() {
    hideEmptyState();
    const wrap = document.createElement('div');
    wrap.className = 'flex justify-start w-full';
    const bubble = document.createElement('div');
    bubble.className = 'assistant-bubble w-full rounded-2xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs sm:text-sm px-3 py-2';
    wrap.appendChild(bubble);
    threadEl().appendChild(wrap);
    scrollThreadToBottom();
    return bubble;
  }

  function showPlain(box, text) {
    box.classList.add('whitespace-pre-wrap');
    show(box, text);
  }

  function show(el, text) {
    el.classList.remove('hidden');
    el.textContent = text;
  }

  function wireBubbleActions(box, userPrompt, copyText) {
    if (!box || !window.OutputActions || !window.OutputActions.attachMessageActions) return;
    try {
      window.OutputActions.attachMessageActions(box, {
        text: copyText || (box.innerText || ''),
        userPrompt: userPrompt || null
      });
    } catch (e) {
      console.warn('[master] wireBubbleActions', e);
    }
  }

  function buildHistoryPayload(email, sessionId) {
    const session = History.get(email, sessionId);
    if (!session) return [];
    return session.messages
      .map(function (m) {
        if (m.role === 'user') return { role: 'user', content: m.content };
        if (m.kind === 'text' && m.content) return { role: 'assistant', content: m.content };
        if (m.kind === 'route' && m.meta) {
          return { role: 'assistant', content: '[Routed to ' + m.meta.agent_id + ' → ' + m.meta.endpoint + ']' };
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

  async function parseJsonResponse(res) {
    const text = await res.text();
    try {
      return JSON.parse(text || '{}');
    } catch (e) {
      throw new Error(
        'Server returned non-JSON (' + res.status + '): ' +
        String(text || '').replace(/\s+/g, ' ').slice(0, 180)
      );
    }
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
      showPlain(appendAssistantBubble(), 'Routing mode is set to "Manual selection only" in Settings.');
      return;
    }

    const c = Quota.consume('master');
    if (!c.ok) {
      showPlain(appendAssistantBubble(), 'Daily Master Agent routing limit reached (' + Quota.limit('master') + '/day).');
      return;
    }

    if (!currentSessionId) {
      const session = History.create(email, message);
      currentSessionId = session.id;
    }

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
    const refundOnce = function () { if (!refunded) { Quota.refund('master'); refunded = true; } };

    const attachmentInfo = attachedFile ? { name: attachedFile.name, type: attachedFile.type } : null;

    try {
      const user = Auth.current() || {};
      const prefs = {
        displayName: (settings.displayName || user.username || '').trim(),
        tone: settings.tone || 'friendly'
      };

      showPlain(assistantBox, 'Loading tools…');
      const mcpTools = await loadMcpToolsForMaster(email);

      showPlain(assistantBox, 'Routing your request…');
      const res = await fetch('/api/master', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: message,
          attachment: attachmentInfo,
          history: priorHistory,
          prefs: prefs,
          mcp_tools: mcpTools
        })
      });
      const data = await parseJsonResponse(res);

      if (!res.ok) {
        refundOnce();
        const errText = 'Error: ' + (data.error || res.status) + (data.detail ? '\n' + data.detail : '');
        showPlain(assistantBox, errText);
        persistAssistantMessage(email, { role: 'assistant', kind: 'text', content: errText, meta: { isError: true } });
        wireBubbleActions(assistantBox, message, errText);
        return;
      }

      badge.textContent = (data.model_used || 'router') + (data.fallback_used ? ' (fallback)' : '');

      if (data.server_executed) {
        renderServerExecutedResult(assistantBox, data);
        persistAssistantMessage(email, {
          role: 'assistant', kind: 'text',
          content: data.result || null,
          meta: {
            source: data.source, model_used: data.model_used, fallback_used: data.fallback_used,
            fallback_note: data.fallback_note, agent_id: data.agent_id
          }
        });
        wireBubbleActions(assistantBox, message, data.result || '');
        if (attachedFile) clearAttachment();
      } else {
        let text =
          'agent: '     + data.agent_id + '\n' +
          'endpoint: '  + data.endpoint + '\n' +
          'params: '    + JSON.stringify(data.params, null, 2) + '\n' +
          'reasoning: ' + data.reasoning +
          (data.fallback_note ? '\n\n⚠ ' + data.fallback_note : '');
        if (attachedFile) {
          text += '\n\n📎 Attachment noted but not sent to this endpoint yet.';
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
            executed: false, executionSummary: null,
            mcp_server_id: data.mcp_server_id || (data.params && data.params.serverId) || null,
            mcp_tool: data.mcp_tool || (data.params && data.params.tool) || null,
            userPrompt: message
          },
          createdAt: new Date().toISOString()
        };
        persistAssistantMessage(email, routeMsg);

        const api = getPrexzyAPI();
        if (data.agent_id === 'mcp') {
          appendMcpExecuteAction(assistantBox, routeMsg, email);
        } else if ((api && api.describe(data.endpoint)) || EXECUTABLE_AGENTS.has(data.agent_id)) {
          appendExecuteAction(assistantBox, routeMsg, email);
        } else if (!api) {
          const warn = document.createElement('div');
          warn.className = 'mt-2 text-[11px] text-amber-600 dark:text-amber-400 font-sans';
          warn.textContent = '⚠ PrexzyAPI not loaded — Execute unavailable.';
          assistantBox.appendChild(warn);
        }
        wireBubbleActions(assistantBox, message, text);
      }
    } catch (e) {
      refundOnce();
      const errText = 'Request failed: ' + e.message;
      showPlain(assistantBox, errText);
      persistAssistantMessage(email, { role: 'assistant', kind: 'text', content: errText, meta: { isError: true } });
      wireBubbleActions(assistantBox, message, errText);
    } finally {
      runBtn.disabled = false;
    }
  }

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
      answerEl.className = 'whitespace-pre-wrap font-mono text-xs text-slate-800 dark:text-slate-100 overflow-x-auto';
      answerEl.textContent = data.result;
    } else {
      answerEl.className = 'text-slate-800 dark:text-slate-100';
      renderMarkdown(answerEl, data.result);
    }

    const labelFn = SOURCE_LABELS[data.source];
    const metaEl = document.createElement('div');
    metaEl.className = 'mt-3 pt-2 border-t border-slate-200 dark:border-slate-700 text-[11px] text-slate-400 font-mono';
    metaEl.textContent = 'via ' + (labelFn ? labelFn(data) : (data.source || 'router'));

    box.append(answerEl, metaEl);

    if (data.fallback_note) {
      const noteEl = document.createElement('div');
      noteEl.className = 'mt-2 text-[11px] text-amber-600 dark:text-amber-400';
      noteEl.textContent = '⚠ ' + data.fallback_note;
      box.append(noteEl);
    }
  }

  function appendMcpExecuteAction(bubbleEl, routeMsg, email) {
    const actions = document.createElement('div');
    actions.className = 'mt-2 pt-2 border-t border-slate-200 dark:border-slate-700 flex items-center gap-2 font-sans';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'text-xs rounded-lg bg-violet-600 text-white px-3 py-1.5 font-medium hover:bg-violet-700 disabled:opacity-50';
    btn.textContent = '▶ Execute MCP';

    const note = document.createElement('span');
    note.className = 'text-[11px] text-slate-400';
    note.textContent = 'calls external MCP server';

    actions.append(btn, note);
    bubbleEl.appendChild(actions);

    btn.addEventListener('click', async function () {
      if (!window.MCPClient) {
        const errBox = document.createElement('div');
        errBox.className = 'mt-2 text-rose-600 dark:text-rose-400 text-xs font-sans';
        errBox.textContent = 'MCPClient is not loaded.';
        bubbleEl.appendChild(errBox);
        return;
      }

      const meta = routeMsg.meta || {};
      const params = meta.params || {};
      const serverId = meta.mcp_server_id || params.serverId;
      const toolName = meta.mcp_tool || params.tool || params.name;
      const userPrompt = meta.userPrompt || '';

      var args = Object.assign({}, params);
      delete args.serverId;
      delete args.tool;
      delete args.name;
      delete args.qualified;

      const servers = MCPClient.listServers(email);
      const server = servers.find(function (s) { return s.id === serverId; });
      if (!server) {
        const errBox = document.createElement('div');
        errBox.className = 'mt-2 text-rose-600 dark:text-rose-400 text-xs font-sans';
        errBox.textContent = 'MCP server not found (id: ' + (serverId || '?') + '). Re-add it in Settings.';
        bubbleEl.appendChild(errBox);
        return;
      }
      if (!toolName) {
        const errBox = document.createElement('div');
        errBox.className = 'mt-2 text-rose-600 dark:text-rose-400 text-xs font-sans';
        errBox.textContent = 'No MCP tool name in route.';
        bubbleEl.appendChild(errBox);
        return;
      }

      // Fill required tool args (CoinGecko execute needs `code`)
      args = ensureMcpArguments(toolName, args, userPrompt, server.name);

      const resultArea = document.createElement('div');
      resultArea.className = 'mt-2 font-sans';
      bubbleEl.appendChild(resultArea);
      showPlain(resultArea, 'Calling MCP tool "' + toolName + '" on ' + server.name + '…');

      btn.disabled = true;
      try {
        const data = await MCPClient.callTool(server, toolName, args);
        if (!data.ok) throw new Error(data.error || 'MCP call failed');

        const text = formatMcpResult(data.result);
        resultArea.classList.remove('whitespace-pre-wrap');
        resultArea.innerHTML = '';
        const answerEl = document.createElement('div');
        answerEl.className = 'text-slate-800 dark:text-slate-100';
        renderMarkdown(answerEl, text);
        const metaEl = document.createElement('div');
        metaEl.className = 'mt-2 pt-2 border-t border-slate-200 dark:border-slate-700 text-[11px] text-slate-400 font-mono';
        metaEl.textContent = 'via MCP — ' + server.name + ' / ' + toolName;
        resultArea.append(answerEl, metaEl);

        routeMsg.meta.executed = true;
        routeMsg.meta.executionSummary = { caption: text.slice(0, 500), mediaUrl: null, mediaKind: null };
        History.updateMessage(email, currentSessionId, routeMsg.id, { meta: routeMsg.meta });
        actions.remove();
      } catch (e) {
        showPlain(resultArea, 'MCP error: ' + e.message);
        btn.disabled = false;
      }
    });
  }

  function formatMcpResult(result) {
    if (result == null) return '(empty result)';
    if (typeof result === 'string') return result;
    if (result.content && Array.isArray(result.content)) {
      return result.content.map(function (c) {
        if (c.type === 'text' && c.text) return c.text;
        if (c.type === 'resource' && c.resource) return JSON.stringify(c.resource, null, 2);
        return JSON.stringify(c);
      }).join('\n\n');
    }
    if (result.structuredContent) return '```json\n' + JSON.stringify(result.structuredContent, null, 2) + '\n```';
    return '```json\n' + JSON.stringify(result, null, 2) + '\n```';
  }

  function appendExecuteAction(bubbleEl, routeMsg, email) {
    const actions = document.createElement('div');
    actions.className = 'mt-2 pt-2 border-t border-slate-200 dark:border-slate-700 flex items-center gap-2 font-sans';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'text-xs rounded-lg bg-emerald-600 text-white px-3 py-1.5 font-medium hover:bg-emerald-700 disabled:opacity-50';
    btn.textContent = '▶ Execute';

    const note = document.createElement('span');
    note.className = 'text-[11px] text-slate-400';
    note.textContent = 'runs the tool (uses that quota)';

    actions.append(btn, note);
    bubbleEl.appendChild(actions);

    btn.addEventListener('click', async function () {
      const endpointKey = routeMsg.meta.endpoint;
      const api = getPrexzyAPI();
      if (!api) {
        const errBox = document.createElement('div');
        errBox.className = 'mt-2 text-rose-600 dark:text-rose-400 text-xs font-sans';
        errBox.textContent = 'PrexzyAPI is not loaded.';
        bubbleEl.appendChild(errBox);
        return;
      }
      const endpoint = api.describe(endpointKey);
      const isVideo = routeMsg.meta.agent_id === 'video' || (endpointKey && endpointKey.indexOf('video.') === 0);
      const isImage = routeMsg.meta.agent_id === 'image' || (endpointKey && endpointKey.indexOf('image.') === 0);

      const settings = Settings.load(email);
      const feature = isVideo ? 'video' : isImage ? 'image' : (endpoint && endpoint.feature);
      if (settings.confirmHeavy && feature && HEAVY_FEATURES.has(feature)) {
        const left = Quota.remaining(feature);
        if (!confirm('This will use 1 ' + feature + ' call (' + left + ' left today). Continue?')) return;
      }

      const resultArea = document.createElement('div');
      resultArea.className = 'mt-2 font-sans';
      bubbleEl.appendChild(resultArea);

      btn.disabled = true;
      try {
        let data;
        if (isVideo) {
          data = await api.generateVideo(routeMsg.meta.params || {}, { loadingEl: resultArea, poll: true });
          if (data && data.url && !data.video_url) data.video_url = data.url;
        } else if (isImage && api.generateImage) {
          data = await api.generateImage(routeMsg.meta.params || {}, { loadingEl: resultArea });
        } else {
          showPlain(resultArea, 'Executing ' + endpointKey + '…');
          data = await api.callResilient(endpointKey, routeMsg.meta.params);
        }
        renderExecutionResult(resultArea, data);
        routeMsg.meta.executed = true;
        routeMsg.meta.executionSummary = summarizeForStorage(resultArea);
        History.updateMessage(email, currentSessionId, routeMsg.id, { meta: routeMsg.meta });
        actions.remove();
      } catch (e) {
        showPlain(resultArea, (e.kind ? '[' + e.kind + '] ' : '') + e.message);
        btn.disabled = false;
      }
    });
  }

  function detectType(url, key) {
    const k = (key || '').toLowerCase();
    if (/cover|thumb|poster|avatar|image|photo|picture|icon|png|jpg|jpeg|webp|gif/.test(k)) return 'image';
    if (/music|audio|mp3|song|sound|voice|tts/.test(k)) return 'audio';
    if (/video|play|mp4|hd|nowm|watermark|download|dl|src|media/.test(k)) return 'video';
    if (/\.(mp4|webm|mov|m3u8)(\?|$)/i.test(url)) return 'video';
    if (/\.(mp3|m4a|wav|aac|ogg)(\?|$)/i.test(url)) return 'audio';
    if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url)) return 'image';
    if (/image|dall|flux|txt2img|genimage/i.test(k)) return 'image';
    return null;
  }

  function collectMediaUrls(obj, found, keyHint) {
    if (found === undefined) found = [];
    if (keyHint === undefined) keyHint = '';
    if (obj == null) return found;
    if (typeof obj === 'string') {
      if (/^https?:\/\//i.test(obj) || /^data:/i.test(obj) || /^blob:/i.test(obj)) {
        found.push({ type: detectType(obj, keyHint) || 'image', url: obj, key: keyHint || 'url', score: 1 });
      }
      return found;
    }
    if (Array.isArray(obj)) {
      obj.forEach(function (item) { collectMediaUrls(item, found, keyHint); });
      return found;
    }
    if (typeof obj === 'object') {
      ['url', 'image_url', 'img_url', 'video_url', 'audio_url', 'path', 'src'].forEach(function (pk) {
        if (typeof obj[pk] === 'string') collectMediaUrls(obj[pk], found, pk);
      });
      Object.keys(obj).forEach(function (k) { collectMediaUrls(obj[k], found, k); });
    }
    return found;
  }

  function findMediaUrl(data) {
    if (!data || typeof data !== 'object') return null;
    var items = collectMediaUrls(data);
    if (!items.length) return null;
    items.sort(function (a, b) {
      var order = { image: 0, video: 1, audio: 2 };
      return (order[a.type] || 9) - (order[b.type] || 9);
    });
    return { kind: items[0].type, url: items[0].url };
  }

  function summarize(data, media) {
    if (data.source && media) return 'Generated ' + media.kind + ' via ' + data.source + '.';
    if (data.prompt && media) return 'Generated ' + media.kind + ' for: "' + data.prompt + '"';
    return media ? 'Generated ' + media.kind + '.' : 'Request completed.';
  }

  function renderExecutionResult(box, data) {
    if (data && data._binary) {
      renderMedia(box, {
        kind: data.contentType.startsWith('image/') ? 'image'
            : data.contentType.startsWith('audio/') ? 'audio' : 'video',
        url: data.url
      }, data._text || 'Done.');
      return;
    }
    if (data && typeof data === 'object') {
      var media = findMediaUrl(data);
      if (media) {
        renderMedia(box, media, summarize(data, media));
        return;
      }
      if (data._text) { showPlain(box, data._text); return; }
      if (data.result || data.response || data.answer || data.message) {
        showPlain(box, String(data.result || data.response || data.answer || data.message));
        return;
      }
    }
    showPlain(box, 'Raw output:\n' + JSON.stringify(data, null, 2));
  }

  function renderMedia(box, media, caption) {
    box.classList.remove('hidden');
    box.innerHTML = '';
    var captionEl = document.createElement('div');
    captionEl.className = 'mb-2 text-slate-700 dark:text-slate-200';
    captionEl.textContent = caption;
    var el = document.createElement(media.kind === 'image' ? 'img' : media.kind === 'audio' ? 'audio' : 'video');
    el.src = media.url;
    if (media.kind !== 'image') el.controls = true;
    el.className = 'max-w-full rounded-lg';
    box.append(captionEl, el);
    if (window.OutputActions && window.OutputActions.attachMediaControls) {
      window.OutputActions.attachMediaControls(box, el, media.url, media.kind, 'canton-node-' + media.kind);
    }
  }

  function summarizeForStorage(resultArea) {
    var mediaEl = resultArea.querySelector('img, audio, video');
    var captionEl = resultArea.querySelector('div');
    var isBlob = !!(mediaEl && /^blob:/i.test(mediaEl.src || ''));
    return {
      caption: captionEl ? captionEl.textContent : resultArea.textContent,
      mediaUrl: mediaEl && !isBlob ? mediaEl.src : null,
      mediaKind: mediaEl ? (mediaEl.tagName === 'IMG' ? 'image' : mediaEl.tagName === 'AUDIO' ? 'audio' : 'video') : null,
      ephemeralMedia: isBlob
    };
  }

  function renderStoredMessage(message, email, userPrompt) {
    if (message.role === 'user') {
      appendUserBubble(message);
      return;
    }

    var box = appendAssistantBubble();

    if (message.kind === 'text') {
      if (message.meta && message.meta.isError) {
        showPlain(box, message.content);
        wireBubbleActions(box, userPrompt, message.content);
        return;
      }
      renderServerExecutedResult(box, {
        result: message.content,
        source: message.meta && message.meta.source,
        agent_id: message.meta && message.meta.agent_id,
        fallback_note: message.meta && message.meta.fallback_note
      });
      wireBubbleActions(box, userPrompt, message.content);
      return;
    }

    box.classList.add('font-mono');
    var text =
      'agent: '     + message.meta.agent_id + '\n' +
      'endpoint: '  + message.meta.endpoint + '\n' +
      'params: '    + JSON.stringify(message.meta.params, null, 2) + '\n' +
      'reasoning: ' + message.meta.reasoning +
      (message.meta.fallback_note ? '\n\n⚠ ' + message.meta.fallback_note : '');
    showPlain(box, text);

    // Keep userPrompt on route for MCP code synthesis after history reload
    if (message.meta && !message.meta.userPrompt && userPrompt) {
      message.meta.userPrompt = userPrompt;
    }

    if (message.meta.executed && message.meta.executionSummary) {
      var s = message.meta.executionSummary;
      var resultArea = document.createElement('div');
      resultArea.className = 'mt-2 pt-2 border-t border-slate-200 dark:border-slate-700 font-sans';
      var captionEl = document.createElement('div');
      captionEl.className = 'text-slate-700 dark:text-slate-200 whitespace-pre-wrap';
      captionEl.textContent = s.caption || '';
      resultArea.appendChild(captionEl);
      if (s.mediaUrl) {
        var el = document.createElement(s.mediaKind === 'image' ? 'img' : s.mediaKind === 'audio' ? 'audio' : 'video');
        el.src = s.mediaUrl;
        if (s.mediaKind !== 'image') el.controls = true;
        el.className = 'max-w-full rounded-lg mt-2';
        resultArea.appendChild(el);
      }
      box.appendChild(resultArea);
    } else if (message.meta.agent_id === 'mcp') {
      appendMcpExecuteAction(box, message, email);
    } else {
      const api = getPrexzyAPI();
      if ((api && api.describe(message.meta.endpoint)) || EXECUTABLE_AGENTS.has(message.meta.agent_id)) {
        appendExecuteAction(box, message, email);
      }
    }
    wireBubbleActions(box, userPrompt, box.innerText || '');
  }

  function renderHistoryList(email) {
    email = email || getEmail();
    var list = document.getElementById('history-list');
    if (!list) return;
    list.innerHTML = '';
    var sessions = email ? History.load(email) : [];
    if (!sessions.length) {
      var p = document.createElement('p');
      p.className = 'text-xs text-slate-400 text-center py-4';
      p.textContent = 'No past chats yet.';
      list.appendChild(p);
      return;
    }
    sessions.forEach(function (session) {
      var isActive = session.id === currentSessionId;
      var item = document.createElement('div');
      item.className = 'group flex items-center gap-1 rounded-lg px-2 py-2 cursor-pointer text-xs ' +
        (isActive ? 'bg-brand-50 dark:bg-slate-700 text-brand-700 dark:text-slate-100 font-medium'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300');
      var titleEl = document.createElement('span');
      titleEl.className = 'flex-1 truncate';
      titleEl.textContent = session.title || 'New chat';
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-500 px-1';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (!confirm('Delete this chat?')) return;
        History.delete(email, session.id);
        if (session.id === currentSessionId) startNewChat();
        else renderHistoryList(email);
      });
      item.addEventListener('click', function () { loadSession(email, session.id); });
      item.append(titleEl, delBtn);
      list.appendChild(item);
    });
  }

  function loadSession(email, sessionId) {
    var session = History.get(email, sessionId);
    if (!session) return;
    currentSessionId = sessionId;
    clearThreadDOM();
    var lastUserPrompt = null;
    session.messages.forEach(function (m) {
      if (m.role === 'user') lastUserPrompt = m.content;
      renderStoredMessage(m, email, lastUserPrompt);
    });
    renderHistoryList(email);
    closeDrawer();
  }

  function startNewChat() {
    currentSessionId = null;
    clearThreadDOM();
    renderHistoryList();
  }

  function openDrawer() {
    var drawer = document.getElementById('history-drawer');
    var backdrop = document.getElementById('history-backdrop');
    if (!drawer || !backdrop) return;
    renderHistoryList();
    drawer.classList.remove('-translate-x-full');
    backdrop.classList.remove('hidden');
  }

  function closeDrawer() {
    var drawer = document.getElementById('history-drawer');
    var backdrop = document.getElementById('history-backdrop');
    if (!drawer || !backdrop) return;
    drawer.classList.add('-translate-x-full');
    backdrop.classList.add('hidden');
  }

  document.addEventListener('DOMContentLoaded', function () {
    var textarea = document.getElementById('master-input');
    document.getElementById('master-run').addEventListener('click', runMasterAgent);
    textarea.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runMasterAgent(); }
    });
    textarea.addEventListener('input', function () { autoGrow(textarea); });

    document.getElementById('master-attach').addEventListener('click', function () {
      document.getElementById('master-file-input').click();
    });
    document.getElementById('master-file-input').addEventListener('change', function () {
      var file = this.files[0];
      if (!file) return;
      attachedFile = file;
      document.getElementById('master-attachment-name').textContent = file.name;
      document.getElementById('master-attachment').classList.remove('hidden');
    });
    document.getElementById('master-attachment-remove').addEventListener('click', clearAttachment);

    var toggleBtn = document.getElementById('btn-history-toggle');
    if (toggleBtn) toggleBtn.addEventListener('click', function () {
      var drawer = document.getElementById('history-drawer');
      if (drawer.classList.contains('-translate-x-full')) openDrawer();
      else closeDrawer();
    });
    var closeBtn = document.getElementById('history-close');
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    var backdrop = document.getElementById('history-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeDrawer);
    var newChatBtn = document.getElementById('history-new-chat');
    if (newChatBtn) newChatBtn.addEventListener('click', function () { startNewChat(); closeDrawer(); });

    window.MasterChat = { reset: startNewChat, closeDrawer: closeDrawer };
  });

})();
