/* api/master.js — GLM-5.2 + tool_stream agent loop + SSE + memory + MCP
 * Hard rule: never role-play "I have no tools". Prefer complete answers; auto-continue if truncated.
 */
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const VINCI_URL = 'https://vinci.getsimpledirect.com/api/v1/chat/completions';
const HF_URL = 'https://router.huggingface.co/v1/chat/completions';
const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
var analyzeAttachment = require('../lib/analyze-attachment').analyzeAttachment;
var kernelLib = null;
try { kernelLib = require('../lib/kernel-lib'); } catch (_) { kernelLib = null; }
var db = null;
try { db = require('../lib/db'); } catch (_) { db = null; }
var memoryIndex = null;
try { memoryIndex = require('../lib/memory-index'); } catch (_) { memoryIndex = null; }
var llmStream = null;
try { llmStream = require('../lib/llm-stream'); } catch (_) { llmStream = null; }
var masterTools = null;
try { masterTools = require('../lib/master-tools'); } catch (_) { masterTools = null; }

const MAX_TOKENS_CHAT = 16000;
const MAX_TOKENS_WEB = 16000;
const MAX_TOKENS_CODE = 32000;
const HISTORY_MSG_CHARS = 10000;
const REF_CHARS = 16000;
const LOG_CHARS = 10000;
const MAX_CONTINUATIONS = 4;
const MAX_TOOL_ROUNDS = 3;

const LLM_CHAIN = [
  { id: 'zhipu', url: ZHIPU_URL, envKey: 'ZAI_API_KEY', altEnvKeys: ['ZHIPU_API_KEY', 'BIGMODEL_API_KEY'],
    models: [{ model: 'glm-5.2', label: 'GLM-5.2' }] },
  { id: 'vinci', url: VINCI_URL, envKey: 'VINCI_API_KEY', models: [{ model: 'forte', label: 'Vinci Forte' }] },
  { id: 'openrouter', url: OPENROUTER_URL, envKey: 'OPENROUTER_API_KEY', models: [
    { model: 'meta-llama/llama-3.3-70b-instruct:free', label: 'OR Llama 3.3' },
    { model: 'google/gemma-4-31b-it:free', label: 'OR Gemma 4' }
  ]},
  { id: 'huggingface', url: HF_URL, envKey: 'HF_TOKEN', models: [
    { model: 'Qwen/Qwen2.5-7B-Instruct', label: 'HF Qwen2.5' }
  ]}
];

function providerApiKey(provider) {
  var keys = [provider.envKey].concat(provider.altEnvKeys || []);
  for (var i = 0; i < keys.length; i++) {
    var v = process.env[keys[i]];
    if (v) return v;
  }
  return null;
}

function orderedLlmChain(prefs) {
  var preferred = String((prefs && (prefs.llmProvider || prefs.chatModel)) || 'auto').toLowerCase().trim();
  var alias = {
    glm: 'zhipu', 'glm-5': 'zhipu', 'glm-5.2': 'zhipu', 'glm5': 'zhipu', 'glm5.2': 'zhipu',
    zai: 'zhipu', bigmodel: 'zhipu', or: 'openrouter'
  };
  if (alias[preferred]) preferred = alias[preferred];
  var chain = LLM_CHAIN.slice();
  if (!preferred || preferred === 'auto') return chain;
  var idx = -1;
  for (var i = 0; i < chain.length; i++) {
    if (chain[i].id === preferred) { idx = i; break; }
  }
  if (idx > 0) {
    var pick = chain.splice(idx, 1)[0];
    chain.unshift(pick);
  }
  return chain;
}

function authHeaders(provider, apiKey) {
  var h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey };
  if (provider.id === 'openrouter') {
    h['HTTP-Referer'] = 'https://canton-node.vercel.app';
    h['X-Title'] = 'Canton Node';
  }
  return h;
}

function zhipuThinkingBody(codeMode, complex) {
  return {
    thinking: { type: 'enabled' },
    reasoning_effort: codeMode ? 'max' : 'high',
    temperature: 1.0
  };
}

function buildRequestBody(provider, modelCfg, messages, maxTokens, opts) {
  opts = opts || {};
  var body = { model: modelCfg.model, messages: messages, max_tokens: maxTokens };
  if (opts.webPlugin && provider.id === 'openrouter') body.plugins = [{ id: 'web', max_results: 5 }];
  if (provider.id === 'zhipu') {
    var extra = zhipuThinkingBody(!!opts.codeMode, !!opts.complex);
    body.thinking = extra.thinking;
    body.reasoning_effort = extra.reasoning_effort;
    body.temperature = extra.temperature;
    if (opts.enableTools && masterTools && masterTools.TOOL_DEFS) {
      body.tools = masterTools.TOOL_DEFS;
      body.tool_choice = 'auto';
      if (opts.streaming) body.tool_stream = true;
    }
  }
  return body;
}

function normalizeMcpTools(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 60).map(function (t) {
    return {
      qualified: t.qualified || ((t.serverName || t.serverId || '') + '.' + (t.name || '')),
      serverId: t.serverId, serverName: t.serverName, name: t.name,
      description: String(t.description || '').slice(0, 200)
    };
  }).filter(function (t) { return t.name; });
}

function normalizeMcpServers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).map(function (s) {
    return {
      id: s.id || '', name: String(s.name || 'MCP').slice(0, 80),
      url: String(s.url || '').slice(0, 240), enabled: s.enabled !== false,
      toolCount: typeof s.toolCount === 'number' ? s.toolCount : (Array.isArray(s.lastTools) ? s.lastTools.length : 0),
      lastError: s.lastError ? String(s.lastError).slice(0, 120) : null
    };
  }).filter(function (s) { return s.name || s.url; });
}

function formatMcpInventory(mcpServers, mcpTools) {
  var servers = mcpServers || [];
  var tools = mcpTools || [];
  if (!servers.length && !tools.length) {
    return 'No MCP servers were sent with this request (user has none connected, or client did not attach inventory).';
  }
  var lines = [];
  if (servers.length) {
    lines.push('Connected MCP servers (' + servers.length + '):');
    servers.forEach(function (s, i) {
      lines.push((i + 1) + '. **' + s.name + '**' + (s.url ? ' — `' + s.url + '`' : '') +
        (s.enabled === false ? ' (disabled)' : '') + (s.toolCount ? ' · ~' + s.toolCount + ' tools cached' : '') +
        (s.lastError ? ' · last error: ' + s.lastError : ''));
    });
  }
  if (tools.length) {
    lines.push('Available MCP tools this turn (' + tools.length + '):');
    var byServer = {};
    tools.forEach(function (t) {
      var key = t.serverName || t.serverId || 'server';
      if (!byServer[key]) byServer[key] = [];
      byServer[key].push(t.name + (t.description ? ' — ' + t.description.slice(0, 80) : ''));
    });
    Object.keys(byServer).forEach(function (sn) {
      lines.push('### ' + sn);
      byServer[sn].slice(0, 15).forEach(function (row) { lines.push('- ' + row); });
      if (byServer[sn].length > 15) lines.push('- … +' + (byServer[sn].length - 15) + ' more');
    });
  }
  return lines.join('\n');
}

function buildThinking(message, route) {
  return [
    '1. Understood: "' + String(message || '').replace(/\s+/g, ' ').trim().slice(0, 120) + '"',
    '2. Route → ' + (route && route.agent_id ? route.agent_id : 'chat'),
    '3. Use tools when live facts are needed. Deliver a complete answer.'
  ].join('\n');
}

function wantsWeb(message) {
  var m = String(message || '').toLowerCase();
  return /\b(web search|search the web|google|look up|lookup|latest|current|news|price of|coingecko|research|does .+ have|is there an?|official (docs?|site)|mcp server|kernel mcp|use (the )?web|use (the )?kernel)\b/.test(m);
}

function codeNeedsWeb(message) {
  var m = String(message || '').toLowerCase();
  return /\b(docs?|documentation|api reference|changelog|npm|pypi|crates\.io|github|stackoverflow|error|exception|stack.?trace|latest version|how (do i|to)|sdk|library|framework|compatibility|deprecated)\b/.test(m);
}

function wantsDeepWeb(message) {
  var m = String(message || '').toLowerCase();
  return /\b(deep search|deep research|read (the )?page|full (page|article)|browse (the )?results?|stealth|kernel mcp)\b/.test(m);
}

function wantsMcpList(message) {
  var m = String(message || '').toLowerCase();
  return /\b(mcp|connected (mcp|servers?|tools?)|my (mcp|servers?|tools?)|list (my )?mcp|what mcp|which mcp|view (the )?mcp|see (the )?mcp)\b/.test(m);
}

function isCodeTask(message) {
  var m = String(message || '').toLowerCase();
  return /\b(code|coding|script|function|class|refactor|bug|debug|implement|edit|fix|modify|patch|javascript|typescript|python|rust|go\b|java\b|sql|regex|algorithm|optimize|unit test|compile|runtime|stack trace|exception)\b/.test(m);
}

function isEditTask(message) {
  var m = String(message || '').toLowerCase();
  return /\b(edit|fix|modify|refactor|rewrite|update|change|patch|correct|repair|improve)\b/.test(m);
}

function isComplexTask(message) {
  var m = String(message || '').toLowerCase();
  return isCodeTask(m) || isEditTask(m) ||
    /\b(architect|design system|migrate|multi-?step|plan then|root cause|diagnose|trade-?off)\b/.test(m);
}

function looksTruncated(text, finishReason) {
  if (llmStream && typeof llmStream.looksIncomplete === 'function') {
    return llmStream.looksIncomplete(text, finishReason);
  }
  if (finishReason === 'length' || finishReason === 'max_tokens') return true;
  var s = String(text || '').trim();
  if (!s) return false;
  return ((s.match(/```/g) || []).length % 2 === 1);
}

function sanitizeCapabilityDenial(text) {
  var s = String(text || '');
  var patterns = [
    /I (don'?t|do not|cannot|can'?t) have access to (any )?(MCP|web search|browse|external tools?)[^.\n]*[.\n]/gi,
    /I (can'?t|cannot) see your connected MCPs[^.\n]*[.\n]/gi,
    /I don'?t have a view into your platform'?s MCP[^.\n]*[.\n]/gi,
    /I have no (external )?tools?[^.\n]*[.\n]/gi,
    /no tool calls are wired[^.\n]*[.\n]/gi,
    /I can'?t call the Kernel MCP[^.\n]*[.\n]/gi,
    /there are genuinely no tools connected[^.\n]*[.\n]/gi,
    /I'?m responding as text only[^.\n]*[.\n]/gi,
    /every attempt to search or browse has come back empty[^.\n]*[.\n]/gi,
    /I don'?t want to give you fabricated URLs[^.\n]*[.\n]/gi
  ];
  for (var i = 0; i < patterns.length; i++) s = s.replace(patterns[i], '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function heuristicRoute(message, mcpTools) {
  var m = message.toLowerCase();
  if (/\b(ocr|analyze (this |the )?(image|photo|screenshot)|describe (this |the )?(image|photo))\b/.test(m))
    return { agent_id: 'analyze', endpoint: 'vision.analyze', params: { prompt: message }, reasoning: 'Heuristic: vision' };
  if (/\b(video|clip|text.?to.?video)\b/.test(m))
    return { agent_id: 'video', endpoint: 'video.create', params: { prompt: message }, reasoning: 'Heuristic: video' };
  if (/\b(image|logo|picture|photo|draw|generate (an? )?image)\b/.test(m))
    return { agent_id: 'image', endpoint: 'image.genimage', params: { prompt: message }, reasoning: 'Heuristic: image' };
  if (/\b(music|song|melody)\b/.test(m))
    return { agent_id: 'music', endpoint: 'music.aimelody', params: { prompt: message }, reasoning: 'Heuristic: music' };
  if (/\b(tts|speak|voice|text.to.speech)\b/.test(m))
    return { agent_id: 'tts', endpoint: 'tts.default', params: { text: message }, reasoning: 'Heuristic: TTS' };
  if ((/\b(browse|visit|scrape)\b/.test(m) && /https?:\/\//.test(message)) ||
      (/\b(kernel|stealth)\b/.test(m) && /https?:\/\//.test(message)))
    return { agent_id: 'browse', endpoint: 'kernel.browse', params: { prompt: message }, reasoning: 'Heuristic: browse' };
  if (wantsWeb(message) || (isCodeTask(message) && codeNeedsWeb(message)))
    return { agent_id: 'web', endpoint: 'web.search', params: { prompt: message, web: true }, reasoning: 'Heuristic: web' };
  if (wantsMcpList(message))
    return { agent_id: 'chat', endpoint: 'chat.answer', params: { prompt: message }, reasoning: 'Heuristic: MCP inventory' };
  return null;
}

async function duckDuckGoSearch(query) {
  try {
    var url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(String(query || '').slice(0, 200));
    var resp = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(14000)
    });
    if (!resp.ok) return { note: '', urls: [] };
    var html = await resp.text();
    var results = [];
    var urls = [];
    var re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html)) && results.length < 5) {
      var href = m[1];
      var title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      var uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch (_) {} }
      if (/^https?:\/\//i.test(href)) urls.push(href);
      results.push((results.length + 1) + '. **' + title + '**\n   ' + href);
    }
    if (!results.length) {
      var re2 = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((m = re2.exec(html)) && results.length < 5) {
        var href2 = m[1];
        var title2 = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (/duckduckgo\.com|javascript:/i.test(href2)) continue;
        urls.push(href2);
        results.push((results.length + 1) + '. **' + title2 + '**\n   ' + href2);
      }
    }
    return { note: results.length ? ('Web search results:\n' + results.join('\n')) : '', urls: urls };
  } catch (_) {
    return { note: '', urls: [] };
  }
}

function buildChatSystemPrompt(prefs, memory, webMode, codeMode, editMode, mcpServers, mcpTools, toolsEnabled) {
  var name = (prefs && prefs.displayName) ? String(prefs.displayName).trim() : '';
  var tone = (prefs && prefs.tone) ? String(prefs.tone) : 'friendly';
  var lines = [
    'You are the Canton Node Master Agent powered primarily by GLM-5.2 — a senior engineer and problem-solver.',
    'CAPABILITY LAW (non-negotiable):',
    '- This platform provides web search, page browse (Kernel stealth when keyed), image/video/music/TTS/code, MCP proxy, and vector memory.',
    '- The user\'s connected MCP servers and tools for THIS request are listed under MCP INVENTORY. Treat that list as ground truth.',
    '- When the user asks what MCPs they connected, list them from MCP INVENTORY or call list_connected_mcps. Never say you cannot see them.',
    '- NEVER say you lack tools, cannot search, cannot browse, or that no tools are connected when inventory or platform tools exist.',
    'REASONING LAW:',
    '- Think step-by-step. Prefer correct, complete solutions over fast sketches.',
    '- When tool results or live extracts appear, treat them as ground truth and cite them.',
    '- When agent memory / reference is present, apply those conventions while solving.',
    'COMPLETENESS: Never truncate. Prefer one complete deliverable over a partial sketch.',
    'Answer in clean Markdown.'
  ];
  if (toolsEnabled) {
    lines.push(
      'TOOLS (call when useful — do not invent results):',
      '- web_search: live web SERP for docs, APIs, prices, news.',
      '- browse_url: read a specific https page (stealth when available).',
      '- list_connected_mcps: list user MCP servers/tools for this session.',
      'After tool results arrive, synthesize a final answer. Do not stop after only calling tools.'
    );
  }
  if (codeMode) {
    lines.push(
      'CODING (GLM-5.2 engineering mode):',
      '- Output complete, runnable code; close every brace and fence.',
      '- Diagnose root causes; use web_search/browse_url for current APIs when needed.',
      '- Prefer minimal correct diffs when editing; state what changed and why.',
      '- No placeholder stubs unless the user asked for stubs.'
    );
  }
  if (editMode) {
    lines.push(
      'FILE EDIT (mandatory): Apply the requested edits. Returning the original unchanged is a failure.',
      'Output the COMPLETE modified file in one fenced code block, then short bullets of what changed.'
    );
  }
  if (webMode) {
    lines.push('Prefer live tool results and page extracts over thin guesses.');
    lines.push('Known fact when relevant: Kernel official MCP https://mcp.onkernel.com/mcp');
  }
  lines.push('--- MCP INVENTORY (live from user client this request) ---');
  lines.push(formatMcpInventory(mcpServers, mcpTools));
  lines.push('--- End MCP inventory ---');
  if (name) lines.push('Address the user as "' + name.replace(/"/g, '') + '" when natural.');
  lines.push('Reply tone: ' + tone + '.');
  if (memory && memory.enabled) {
    if (memory.reference) {
      if (memory.retrieved) {
        lines.push('--- Retrieved agent memory (LEARN FROM THIS while performing the task) ---');
        lines.push(String(memory.reference).slice(0, REF_CHARS));
        lines.push('--- End retrieved memory ---');
      } else {
        lines.push('--- Agent reference (use while performing the task) ---');
        lines.push(String(memory.reference).slice(0, REF_CHARS));
        lines.push('--- End agent reference ---');
      }
    }
    if (memory.user_logs) {
      lines.push('--- User log (preferences & past outcomes) ---');
      lines.push(String(memory.user_logs).slice(0, LOG_CHARS));
    }
  }
  return lines.join('\n');
}

async function resolveMemoryForRequest(token, message, memory) {
  if (!memory || memory.enabled === false) return memory || null;
  if (!token || !db || !memoryIndex || !db.hasDatabase()) return memory;
  try {
    var email = await db.resolveEmailFromToken(token);
    if (!email) return memory;
    var enriched = await memoryIndex.enrichMemory(email, message, memory);
    return enriched || memory;
  } catch (e) {
    console.error('[master] memory enrich', e && e.message);
    return memory;
  }
}

async function callOnce(provider, apiKey, modelCfg, messages, maxTokens, opts) {
  opts = opts || {};
  var body = buildRequestBody(provider, modelCfg, messages, maxTokens, opts);
  if (llmStream && llmStream.completeOnce) {
    return llmStream.completeOnce(provider.url, authHeaders(provider, apiKey), body, 120000);
  }
  var resp = await fetch(provider.url, {
    method: 'POST', headers: authHeaders(provider, apiKey),
    body: JSON.stringify(body), signal: AbortSignal.timeout(120000)
  });
  if (!resp.ok) { var err = new Error('HTTP ' + resp.status); err.status = resp.status; throw err; }
  var data = await resp.json();
  var choice = data && data.choices && data.choices[0];
  var msg = choice && choice.message;
  var text = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
  var finishReason = (choice && (choice.finish_reason || choice.native_finish_reason)) || '';
  var toolCalls = (msg && Array.isArray(msg.tool_calls)) ? msg.tool_calls : [];
  return {
    text: text,
    finishReason: String(finishReason || '').toLowerCase(),
    toolCalls: toolCalls
  };
}

/**
 * Agentic generate: stream text, execute tool_calls (GLM-5.2 tool_stream), continue up to MAX_TOOL_ROUNDS.
 */
async function generateWithContinuation(provider, apiKey, modelCfg, system, prior, userContent, maxTokens, opts, onDelta) {
  opts = opts || {};
  var enableTools = !!(opts.enableTools && provider.id === 'zhipu' && masterTools);
  var toolCtx = { mcpServers: opts.mcpServers || [], mcpTools: opts.mcpTools || [] };
  var messages = [{ role: 'system', content: system }].concat(prior || []).concat([{ role: 'user', content: userContent }]);
  var toolRounds = 0;
  var totalTools = 0;
  var full = '';
  var finish = '';
  var cont = 0;

  while (true) {
    var callOpts = Object.assign({}, opts, {
      enableTools: enableTools,
      streaming: !!(onDelta)
    });
    // After first tool round, still allow tools until max
    if (toolRounds >= MAX_TOOL_ROUNDS) callOpts.enableTools = false;

    var turn;
    if (onDelta && llmStream && llmStream.streamOnce) {
      try {
        turn = await llmStream.streamOnce(
          provider.url, authHeaders(provider, apiKey),
          buildRequestBody(provider, modelCfg, messages, maxTokens, callOpts),
          function (delta, soFar, meta) {
            if (delta) onDelta(delta, soFar, meta);
          },
          120000
        );
      } catch (streamErr) {
        turn = await callOnce(provider, apiKey, modelCfg, messages, maxTokens, callOpts);
        if (turn.text && onDelta) onDelta(turn.text, turn.text, {});
      }
    } else {
      turn = await callOnce(provider, apiKey, modelCfg, messages, maxTokens, callOpts);
      if (turn.text && onDelta) onDelta(turn.text, turn.text, {});
    }

    var toolCalls = (turn.toolCalls && turn.toolCalls.length) ? turn.toolCalls : [];
    finish = turn.finishReason || '';
    if (turn.text) full = (full ? full + (full.endsWith('\n') ? '' : '\n') : '') + turn.text;

    // Tool-calling branch
    if (enableTools && toolCalls.length && toolRounds < MAX_TOOL_ROUNDS && masterTools) {
      toolRounds++;
      totalTools += toolCalls.length;
      if (onDelta) {
        var names = toolCalls.map(function (t) {
          return (t.function && t.function.name) || 'tool';
        }).join(', ');
        onDelta('\n\n_🔧 Using tools: ' + names + '_\n\n', full + '\n\n_🔧 Using tools: ' + names + '_\n\n', { toolProgress: true });
      }
      messages.push({
        role: 'assistant',
        content: turn.text || null,
        tool_calls: toolCalls
      });
      var toolMsgs = await masterTools.runToolCalls(toolCalls, toolCtx);
      for (var ti = 0; ti < toolMsgs.length; ti++) messages.push(toolMsgs[ti]);
      continue;
    }

    // Text answer path — auto-continue if truncated
    if (!full && !turn.text) {
      return { text: '', finishReason: finish, continuations: cont, toolRounds: toolRounds, toolsUsed: totalTools };
    }
    if (!full) full = turn.text || '';

    while (cont < MAX_CONTINUATIONS && looksTruncated(full, finish)) {
      cont++;
      var contMessages = messages.concat([
        { role: 'assistant', content: full },
        { role: 'user', content: 'Continue exactly from where you left off. Do not repeat prior text. Close open code fences. Finish the complete answer.' }
      ]);
      var next = await callOnce(provider, apiKey, modelCfg, contMessages, maxTokens, {
        codeMode: opts.codeMode,
        complex: opts.complex,
        enableTools: false
      });
      if (!next.text) break;
      var piece = next.text;
      if (full.endsWith(piece.slice(0, Math.min(40, piece.length)))) {
        piece = piece.slice(Math.min(40, piece.length));
      }
      if (!piece) break;
      full = full + (full.endsWith('\n') ? '' : '\n') + piece;
      if (onDelta) onDelta('\n' + piece, full, {});
      finish = next.finishReason;
      if (!looksTruncated(full, finish)) break;
    }
    break;
  }

  return {
    text: full,
    finishReason: finish,
    continuations: cont,
    toolRounds: toolRounds,
    toolsUsed: totalTools
  };
}

async function prepareUserContent(message, opts) {
  opts = opts || {};
  var webMode = !!opts.web;
  var useNativeTools = !!opts.useNativeTools;
  var mcpServers = opts.mcpServers || [];
  var mcpTools = opts.mcpTools || [];
  var userContent = message;
  var deepUsed = false;
  var searchHitCount = 0;

  // When GLM tool_stream is active, skip pre-injected SERP so the model can call web_search itself.
  // Still inject MCP inventory for visibility.
  if (webMode && !useNativeTools) {
    var search = await duckDuckGoSearch(message);
    var searchNote = search.note || '';
    searchHitCount = (search.urls && search.urls.length) || 0;
    if (searchNote) {
      userContent = message + '\n\n---\n' + searchNote + '\n---\nUse the search results while solving. Cite links in Markdown.';
    } else {
      userContent = message +
        '\n\n---\n[Server status] Canton Node ran web search; SERP returned 0 hits. Do NOT claim you lack tools.\n---';
    }
    var canDeep = kernelLib && typeof kernelLib.deepReadUrls === 'function' && kernelLib.kernelKey && kernelLib.kernelKey();
    if (canDeep && search.urls && search.urls.length) {
      var maxPages = wantsDeepWeb(message) || isCodeTask(message) ? 2 : 1;
      try {
        var deep = await kernelLib.deepReadUrls(search.urls, maxPages);
        if (deep && deep.ok && deep.text) {
          userContent += '\n\n---\n' + deep.text + '\n---\nPrefer these live extracts.';
          deepUsed = true;
        }
      } catch (deepErr) {
        console.error('[master deep]', deepErr && deepErr.message);
      }
    }
  } else if (useNativeTools) {
    userContent = message +
      '\n\n(You have tools: web_search, browse_url, list_connected_mcps. Call them when live data is needed.)';
  }

  if (wantsMcpList(message) || mcpServers.length || mcpTools.length) {
    userContent += '\n\n---\nMCP INVENTORY (answer from this; do not deny visibility):\n' +
      formatMcpInventory(mcpServers, mcpTools) + '\n---';
  }
  return { userContent: userContent, deepUsed: deepUsed, searchHitCount: searchHitCount };
}

async function tryGenerateAnswer(message, history, prefs, memory, opts) {
  opts = opts || {};
  var webMode = !!opts.web;
  var codeMode = !!opts.code || !!opts.edit || isCodeTask(message) || isEditTask(message);
  var editMode = !!opts.edit || isEditTask(message);
  var complex = isComplexTask(message);
  var mcpServers = opts.mcpServers || [];
  var mcpTools = opts.mcpTools || [];
  var onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : null;
  var attempts = [];
  var prior = (history || []).slice(-10);
  var maxTokens = codeMode ? MAX_TOKENS_CODE : (webMode ? MAX_TOKENS_WEB : MAX_TOKENS_CHAT);

  var chain = orderedLlmChain(prefs || {});
  // Prefer native tools on Zhipu when available
  var zhipuAvailable = false;
  for (var zi = 0; zi < chain.length; zi++) {
    if (chain[zi].id === 'zhipu' && providerApiKey(chain[zi])) { zhipuAvailable = true; break; }
  }
  var useNativeTools = !!(masterTools && zhipuAvailable);

  var prep = await prepareUserContent(message, {
    web: webMode,
    useNativeTools: useNativeTools,
    mcpServers: mcpServers,
    mcpTools: mcpTools
  });
  var userContent = prep.userContent;
  var deepUsed = prep.deepUsed;
  var searchHitCount = prep.searchHitCount;

  var system = buildChatSystemPrompt(
    prefs || {}, memory || null, webMode, codeMode, editMode, mcpServers, mcpTools, useNativeTools
  );

  for (var pi = 0; pi < chain.length; pi++) {
    var provider = chain[pi];
    var apiKey = providerApiKey(provider);
    if (!apiKey) { attempts.push({ endpoint: provider.id, error: 'key missing' }); continue; }
    for (var mi = 0; mi < provider.models.length; mi++) {
      var m = provider.models[mi];
      try {
        var enableTools = useNativeTools && provider.id === 'zhipu';
        var out = await generateWithContinuation(
          provider, apiKey, m, system, prior, userContent, maxTokens,
          {
            webPlugin: webMode && provider.id === 'openrouter',
            codeMode: codeMode,
            complex: complex,
            enableTools: enableTools,
            mcpServers: mcpServers,
            mcpTools: mcpTools
          },
          onDelta
        );
        if (out.text) {
          var cleaned = sanitizeCapabilityDenial(out.text);
          if (!cleaned) cleaned = out.text;
          var badge = m.label;
          if (out.toolsUsed) badge += ' · tools×' + out.toolsUsed;
          else if (webMode) badge += deepUsed ? ' · web+stealth' : ' · web';
          if (codeMode) badge += ' · code';
          if (out.continuations) badge += ' · cont×' + out.continuations;
          return {
            text: cleaned,
            model: badge,
            provider: provider.id,
            attempts: attempts,
            web: webMode || !!(out.toolsUsed),
            deep: deepUsed,
            search_hits: searchHitCount,
            mcp_servers: mcpServers.length,
            mcp_tools: mcpTools.length,
            continuations: out.continuations || 0,
            tools_used: out.toolsUsed || 0,
            tool_rounds: out.toolRounds || 0
          };
        }
        attempts.push({ endpoint: m.model, error: 'empty' });
      } catch (e) {
        attempts.push({ endpoint: m.model, error: e.message });
      }
    }
  }
  return {
    text: null, model: null, provider: null, attempts: attempts,
    web: webMode, deep: deepUsed, search_hits: searchHitCount,
    mcp_servers: mcpServers.length, mcp_tools: mcpTools.length
  };
}

function sseWrite(res, event, data) {
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(data) + '\n\n');
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed. Use POST.' }); return; }
    var body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    var message = String(body.message || '').trim();
    var prefs = (body.prefs && typeof body.prefs === 'object') ? body.prefs : {};
    var memory = (body.memory && typeof body.memory === 'object') ? body.memory : null;
    var token = String(body.token || '').trim();
    var wantStream = !!(body.stream);
    var mcpTools = normalizeMcpTools(body.mcp_tools);
    var mcpServers = normalizeMcpServers(body.mcp_servers);
    if (!mcpServers.length && mcpTools.length) {
      var seen = {};
      mcpTools.forEach(function (t) {
        var key = t.serverId || t.serverName || 'unknown';
        if (seen[key]) return;
        seen[key] = true;
        mcpServers.push({ id: t.serverId || key, name: t.serverName || key, url: '', enabled: true, toolCount: 0, lastError: null });
      });
      mcpServers.forEach(function (s) {
        s.toolCount = mcpTools.filter(function (t) {
          return (t.serverId || t.serverName) === (s.id || s.name);
        }).length;
      });
    }
    var attachment = body.attachment || null;
    var forceWeb = !!(body.web || body.force_web || (prefs && prefs.forceWeb));
    var history = [];
    if (Array.isArray(body.history)) {
      history = body.history
        .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; })
        .slice(-12)
        .map(function (m) { return { role: m.role, content: String(m.content).slice(0, HISTORY_MSG_CHARS) }; });
    }
    if (!message && !(attachment && (attachment.dataUrl || attachment.text))) {
      res.status(400).json({ error: 'Missing "message" (or attach a file).' }); return;
    }
    if (!message && attachment) {
      message = attachment.kind === 'image'
        ? 'Analyze this image. Describe it, OCR any text, and note important details.'
        : 'Analyze this file and summarize the important points.';
    }

    memory = await resolveMemoryForRequest(token, message, memory);

    if (attachment && (attachment.dataUrl || attachment.text)) {
      var t0 = Date.now();
      var analyzed = await analyzeAttachment(message, attachment, history, prefs, function (msg, hist, pr, mem, o) {
        return tryGenerateAnswer(msg, hist, pr, mem || memory, o || { web: false, mcpServers: mcpServers, mcpTools: mcpTools });
      });
      res.status(200).json({
        ok: true, agent_id: 'analyze', endpoint: 'vision.analyze',
        params: { name: attachment.name, type: attachment.type, kind: attachment.kind },
        reasoning: 'Attachment analysis / file edit',
        thinking: analyzed.thinking || null, thinking_ms: Date.now() - t0,
        server_executed: true, result: analyzed.text,
        model_used: analyzed.model, provider: analyzed.provider, attempts: analyzed.attempts || [],
        memory_retrieved: !!(memory && memory.retrieved),
        memory_hits: (memory && memory.hit_count) || 0,
        mcp_servers: mcpServers.length, mcp_tools: mcpTools.length
      });
      return;
    }

    var route = heuristicRoute(message, mcpTools);
    if (!route) route = { agent_id: 'chat', endpoint: 'chat.answer', params: { prompt: message }, reasoning: 'Default chat' };
    if (forceWeb && route.agent_id === 'chat') {
      route = { agent_id: 'web', endpoint: 'web.search', params: { prompt: message, web: true }, reasoning: 'Client forced web' };
    }
    route.thinking = buildThinking(message, route);

    if (route.agent_id === 'browse') {
      var tBrowse = Date.now();
      try {
        if (kernelLib && kernelLib.tryKernelBrowse) {
          var k = await kernelLib.tryKernelBrowse(message);
          if (k && k.ok) {
            res.status(200).json({
              ok: true, agent_id: 'browse', endpoint: 'kernel.browse',
              thinking: route.thinking, thinking_ms: Date.now() - tBrowse,
              server_executed: true, result: k.text || k.result, reasoning: route.reasoning,
              model_used: k.source || 'browse'
            });
            return;
          }
        }
      } catch (browseErr) { console.error('[master browse]', browseErr); }
      var genBrowse = await tryGenerateAnswer(
        message + '\n\n(Browse unavailable this turn. Answer from web context if any.)',
        history, prefs, memory,
        { web: true, mcpServers: mcpServers, mcpTools: mcpTools }
      );
      res.status(200).json({
        ok: true, agent_id: 'web', endpoint: 'web.search',
        thinking: route.thinking, thinking_ms: Date.now() - tBrowse,
        server_executed: !!genBrowse.text,
        result: genBrowse.text || 'Could not browse. Paste a full https:// URL and say Browse.',
        model_used: genBrowse.model, provider: genBrowse.provider, reasoning: 'Browse fallback → web',
        memory_retrieved: !!(memory && memory.retrieved),
        deep: !!genBrowse.deep
      });
      return;
    }

    if (route.agent_id === 'chat' || route.agent_id === 'web' || route.agent_id === 'analyze') {
      var useWeb = forceWeb || route.agent_id === 'web' || wantsWeb(message) ||
        (isCodeTask(message) && codeNeedsWeb(message));

      if (wantStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        sseWrite(res, 'meta', {
          ok: true,
          agent_id: useWeb ? 'web' : route.agent_id,
          endpoint: useWeb ? 'web.search' : route.endpoint,
          thinking: route.thinking,
          reasoning: route.reasoning,
          model_hint: 'GLM-5.2',
          tools: true
        });
        try {
          var genS = await tryGenerateAnswer(message, history, prefs, memory, {
            web: useWeb,
            code: isCodeTask(message),
            edit: isEditTask(message),
            mcpServers: mcpServers,
            mcpTools: mcpTools,
            onDelta: function (delta, full) {
              if (delta) sseWrite(res, 'delta', { text: delta, full_len: (full || '').length });
            }
          });
          var finalText = genS.text ? sanitizeCapabilityDenial(genS.text) : null;
          if (!finalText) finalText = genS.text;
          sseWrite(res, 'done', {
            ok: true,
            server_executed: !!finalText,
            result: finalText || 'No model answered. Check API keys (ZAI / VINCI / OPENROUTER).',
            model_used: genS.model,
            provider: genS.provider,
            attempts: genS.attempts || [],
            web: !!genS.web,
            deep: !!genS.deep,
            search_hits: genS.search_hits || 0,
            mcp_servers: mcpServers.length,
            mcp_tools: mcpTools.length,
            continuations: genS.continuations || 0,
            tools_used: genS.tools_used || 0,
            tool_rounds: genS.tool_rounds || 0,
            memory_retrieved: !!(memory && memory.retrieved),
            memory_hits: (memory && memory.hit_count) || 0
          });
        } catch (streamErr) {
          sseWrite(res, 'error', { error: String(streamErr && streamErr.message ? streamErr.message : streamErr).slice(0, 300) });
        }
        res.end();
        return;
      }

      var gen = await tryGenerateAnswer(message, history, prefs, memory, {
        web: useWeb,
        code: isCodeTask(message),
        edit: isEditTask(message),
        mcpServers: mcpServers,
        mcpTools: mcpTools
      });
      res.status(200).json({
        ok: true,
        agent_id: useWeb ? 'web' : route.agent_id,
        endpoint: useWeb ? 'web.search' : route.endpoint,
        params: route.params || {},
        reasoning: (gen.tools_used
          ? ('Agent tools ×' + gen.tools_used)
          : (useWeb
            ? (gen.deep ? 'Web + Kernel stealth page extract' : (route.reasoning || 'Web-enabled answer'))
            : route.reasoning)),
        thinking: route.thinking, thinking_ms: 0,
        server_executed: !!gen.text,
        result: gen.text || 'No model answered. Check API keys (ZAI / VINCI / OPENROUTER).',
        model_used: gen.model, provider: gen.provider, attempts: gen.attempts || [],
        web: !!gen.web, deep: !!gen.deep, search_hits: gen.search_hits || 0,
        mcp_servers: mcpServers.length, mcp_tools: mcpTools.length,
        continuations: gen.continuations || 0,
        tools_used: gen.tools_used || 0,
        tool_rounds: gen.tool_rounds || 0,
        memory_retrieved: !!(memory && memory.retrieved),
        memory_hits: (memory && memory.hit_count) || 0
      });
      return;
    }

    res.status(200).json({
      ok: true, agent_id: route.agent_id, endpoint: route.endpoint,
      params: route.params || {}, reasoning: route.reasoning,
      thinking: route.thinking, thinking_ms: 0, server_executed: false,
      mcp_servers: mcpServers.length, mcp_tools: mcpTools.length
    });
  } catch (err) {
    console.error('[master]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: String(err && err.message ? err.message : err).slice(0, 300) });
    } else {
      try {
        sseWrite(res, 'error', { error: String(err && err.message ? err.message : err).slice(0, 300) });
        res.end();
      } catch (_) {}
    }
  }
};

module.exports.config = { maxDuration: 120 };
