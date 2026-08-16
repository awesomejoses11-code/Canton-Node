/* api/master.js — chat + attachment + file-edit + vector memory + stealth web
 * Hard rule: never role-play "I have no tools / cannot search".
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

const MAX_TOKENS_CHAT = 12000;
const MAX_TOKENS_WEB = 12000;
const MAX_TOKENS_CODE = 16000;
const HISTORY_MSG_CHARS = 8000;
const REF_CHARS = 12000;
const LOG_CHARS = 8000;
const MAX_CONTINUATIONS = 3;

const LLM_CHAIN = [
  { id: 'zhipu', url: ZHIPU_URL, envKey: 'ZAI_API_KEY', altEnvKeys: ['ZHIPU_API_KEY', 'BIGMODEL_API_KEY'],
    models: [{ model: 'glm-5', label: 'GLM-5' }] },
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
  var alias = { glm: 'zhipu', 'glm-5': 'zhipu', zai: 'zhipu', bigmodel: 'zhipu', or: 'openrouter' };
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

function normalizeMcpTools(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 40).map(function (t) {
    return {
      qualified: t.qualified || ((t.serverName || t.serverId || '') + '.' + (t.name || '')),
      serverId: t.serverId, serverName: t.serverName, name: t.name,
      description: String(t.description || '').slice(0, 200)
    };
  }).filter(function (t) { return t.name; });
}

function buildThinking(message, route) {
  return [
    '1. Understood: "' + String(message || '').replace(/\s+/g, ' ').trim().slice(0, 120) + '"',
    '2. Route → ' + (route && route.agent_id ? route.agent_id : 'chat'),
    '3. Deliver a complete, non-truncated final answer. Never claim missing tools.'
  ].join('\n');
}

function wantsWeb(message) {
  var m = String(message || '').toLowerCase();
  return /\b(web search|search the web|google|look up|lookup|latest|current|news|price of|coingecko|research|does .+ have|is there an?|official (docs?|site)|mcp server|kernel mcp|use (the )?web|use (the )?kernel)\b/.test(m);
}

function wantsDeepWeb(message) {
  var m = String(message || '').toLowerCase();
  return /\b(deep search|deep research|read (the )?page|full (page|article)|browse (the )?results?|stealth|kernel mcp)\b/.test(m);
}

function isCodeTask(message) {
  var m = String(message || '').toLowerCase();
  return /\b(code|coding|script|function|class|refactor|bug|debug|implement|edit|fix|modify|patch|javascript|typescript|python)\b/.test(m);
}

function isEditTask(message) {
  var m = String(message || '').toLowerCase();
  return /\b(edit|fix|modify|refactor|rewrite|update|change|patch|correct|repair|improve)\b/.test(m);
}

function looksTruncated(text, finishReason) {
  if (finishReason === 'length' || finishReason === 'max_tokens') return true;
  var s = String(text || '').trim();
  if (!s) return false;
  return ((s.match(/```/g) || []).length % 2 === 1);
}

/** Strip model habit of denying platform capabilities. */
function sanitizeCapabilityDenial(text) {
  var s = String(text || '');
  var patterns = [
    /I (don'?t|do not|cannot|can'?t) have access to (any )?(MCP|web search|browse|external tools?)[^.\n]*[.\n]/gi,
    /I have no (external )?tools?[^.\n]*[.\n]/gi,
    /no tool calls are wired[^.\n]*[.\n]/gi,
    /I can'?t call the Kernel MCP[^.\n]*[.\n]/gi,
    /there are genuinely no tools connected[^.\n]*[.\n]/gi,
    /I'?m responding as text only[^.\n]*[.\n]/gi,
    /every attempt to search or browse has come back empty[^.\n]*[.\n]/gi,
    /I don'?t want to give you fabricated URLs[^.\n]*[.\n]/gi
  ];
  for (var i = 0; i < patterns.length; i++) {
    s = s.replace(patterns[i], '');
  }
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
  if (wantsWeb(message))
    return { agent_id: 'web', endpoint: 'web.search', params: { prompt: message, web: true }, reasoning: 'Heuristic: web' };
  return null;
}

/** @returns {{ note: string, urls: string[] }} */
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
    // Alternate markup some DDG edges return
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
    return {
      note: results.length ? ('Web search results:\n' + results.join('\n')) : '',
      urls: urls
    };
  } catch (_) {
    return { note: '', urls: [] };
  }
}

function buildChatSystemPrompt(prefs, memory, webMode, codeMode, editMode) {
  var name = (prefs && prefs.displayName) ? String(prefs.displayName).trim() : '';
  var tone = (prefs && prefs.tone) ? String(prefs.tone) : 'friendly';
  var lines = [
    'You are the Canton Node Master Agent — a multi-tool assistant on a live platform.',
    'CAPABILITY LAW (non-negotiable):',
    '- This platform provides web search, page browse (Kernel stealth when keyed), image/video/music/TTS/code, MCP proxy, and memory.',
    '- NEVER say you lack tools, cannot search, cannot browse, or that no tools are connected.',
    '- NEVER write "I don\'t have access to MCP/web/browse" or "responding as text only".',
    '- If search results in the prompt are empty, say results were empty — do not invent a missing-tool story.',
    '- If live extracts are present, prefer them. If only SERP links exist, use those. If neither, answer from knowledge and say so briefly.',
    'COMPLETENESS: Never truncate. Prefer one complete deliverable over a partial sketch.',
    'Do not write "..." / "rest omitted" / "TODO: implement" as a substitute for real content.',
    'Answer in clean Markdown.'
  ];
  if (codeMode) {
    lines.push(
      'CODING: Output complete runnable code; close every brace and fence.',
      'No placeholder stubs unless the user asked for stubs.',
      'Apply Agent reference conventions when present.'
    );
  }
  if (editMode) {
    lines.push(
      'FILE EDIT (mandatory): Apply the requested edits. Returning the original unchanged is a failure.',
      'Output the COMPLETE modified file in one fenced code block, then short bullets of what changed.'
    );
  }
  if (webMode) {
    lines.push('Use provided search results and any live page extracts; do not invent URLs or prices.');
    lines.push('Prefer live page extracts over thin SERP snippets when both are present.');
    lines.push('Known fact when relevant: Kernel ships an official MCP at https://mcp.onkernel.com/mcp (docs: kernel.sh/docs/reference/mcp-server).');
  }
  if (name) lines.push('Address the user as "' + name.replace(/"/g, '') + '" when natural.');
  lines.push('Reply tone: ' + tone + '.');
  if (memory && memory.enabled) {
    if (memory.reference) {
      if (memory.retrieved) {
        lines.push('--- Retrieved agent memory (use while performing the task) ---');
        lines.push('Prefer these facts when they conflict with generic assumptions.');
        lines.push(String(memory.reference).slice(0, REF_CHARS));
        lines.push('--- End retrieved memory ---');
      } else {
        lines.push('--- Agent reference (use while performing the task) ---');
        lines.push(String(memory.reference).slice(0, REF_CHARS));
        lines.push('--- End agent reference ---');
      }
    }
    if (memory.user_logs) {
      lines.push('--- User log ---');
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

async function callOnce(provider, apiKey, modelCfg, messages, maxTokens, webPlugin) {
  var body = { model: modelCfg.model, messages: messages, max_tokens: maxTokens };
  if (webPlugin && provider.id === 'openrouter') body.plugins = [{ id: 'web', max_results: 5 }];
  var resp = await fetch(provider.url, {
    method: 'POST', headers: authHeaders(provider, apiKey),
    body: JSON.stringify(body), signal: AbortSignal.timeout(90000)
  });
  if (!resp.ok) { var err = new Error('HTTP ' + resp.status); err.status = resp.status; throw err; }
  var data = await resp.json();
  var choice = data && data.choices && data.choices[0];
  var msg = choice && choice.message;
  var text = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
  var finishReason = (choice && (choice.finish_reason || choice.native_finish_reason)) || '';
  return { text: text, finishReason: String(finishReason || '').toLowerCase() };
}

async function generateWithContinuation(provider, apiKey, modelCfg, system, prior, userContent, maxTokens, webPlugin) {
  var messages = [{ role: 'system', content: system }].concat(prior || []).concat([{ role: 'user', content: userContent }]);
  var first = await callOnce(provider, apiKey, modelCfg, messages, maxTokens, webPlugin);
  if (!first.text) return first;
  var full = first.text;
  var finish = first.finishReason;
  var cont = 0;
  while (cont < MAX_CONTINUATIONS && looksTruncated(full, finish)) {
    cont++;
    var contMessages = messages.concat([
      { role: 'assistant', content: full },
      { role: 'user', content: 'Continue exactly from where you left off. Do not repeat. Close open fences. Finish completely.' }
    ]);
    var next = await callOnce(provider, apiKey, modelCfg, contMessages, maxTokens, false);
    if (!next.text) break;
    full = full + (full.endsWith('\n') ? '' : '\n') + next.text;
    finish = next.finishReason;
    if (!looksTruncated(full, finish)) break;
  }
  return { text: full, finishReason: finish, continuations: cont };
}

async function tryGenerateAnswer(message, history, prefs, memory, opts) {
  opts = opts || {};
  var webMode = !!opts.web;
  var codeMode = !!opts.code || !!opts.edit || isCodeTask(message) || isEditTask(message);
  var editMode = !!opts.edit || isEditTask(message);
  var attempts = [];
  var prior = (history || []).slice(-8);
  var userContent = message;
  var maxTokens = codeMode ? MAX_TOKENS_CODE : (webMode ? MAX_TOKENS_WEB : MAX_TOKENS_CHAT);
  var deepUsed = false;
  var searchHitCount = 0;

  if (webMode) {
    var search = await duckDuckGoSearch(message);
    var searchNote = search.note || '';
    searchHitCount = (search.urls && search.urls.length) || 0;
    if (searchNote) {
      userContent = message + '\n\n---\n' + searchNote + '\n---\nUse the search results. Cite links in Markdown.';
    } else {
      userContent = message +
        '\n\n---\n[Server status] Canton Node ran web search for this turn; SERP returned 0 parseable hits (provider empty or blocked).\n' +
        'Do NOT claim you lack web search or tools. Answer from reliable knowledge; for Kernel MCP specifically you may state the official endpoint https://mcp.onkernel.com/mcp and docs at https://kernel.sh/docs/reference/mcp-server.\n' +
        'If the user provided a URL, they can ask to Browse it for a live extract.\n---';
    }

    var canDeep = kernelLib && typeof kernelLib.deepReadUrls === 'function' &&
      kernelLib.kernelKey && kernelLib.kernelKey();
    if (canDeep && search.urls && search.urls.length) {
      var maxPages = wantsDeepWeb(message) ? 2 : 1;
      try {
        var deep = await kernelLib.deepReadUrls(search.urls, maxPages);
        if (deep && deep.ok && deep.text) {
          userContent += '\n\n---\n' + deep.text + '\n---\nPrefer these live extracts for facts.';
          deepUsed = true;
        }
      } catch (deepErr) {
        console.error('[master deep]', deepErr && deepErr.message);
      }
    }

    // If no SERP but user mentioned Kernel MCP / docs topics, seed verified facts
    if (!searchHitCount && /kernel|mcp/i.test(message)) {
      userContent +=
        '\n\n---\nVerified platform facts (use when SERP empty):\n' +
        '- Kernel official MCP (Streamable HTTP): https://mcp.onkernel.com/mcp\n' +
        '- Docs: https://kernel.sh/docs/reference/mcp-server\n' +
        '- Stealth browsers: create with stealth:true (ISP proxy + CAPTCHA solver)\n' +
        '- Canton Node also browses via server-side Kernel REST when KERNEL_API_KEY is set.\n---';
    }
  }

  var system = buildChatSystemPrompt(prefs || {}, memory || null, webMode, codeMode, editMode);
  var chain = orderedLlmChain(prefs || {});
  for (var pi = 0; pi < chain.length; pi++) {
    var provider = chain[pi];
    var apiKey = providerApiKey(provider);
    if (!apiKey) { attempts.push({ endpoint: provider.id, error: 'key missing' }); continue; }
    for (var mi = 0; mi < provider.models.length; mi++) {
      var m = provider.models[mi];
      try {
        var out = await generateWithContinuation(
          provider, apiKey, m, system, prior, userContent, maxTokens,
          webMode && provider.id === 'openrouter'
        );
        if (out.text) {
          var cleaned = sanitizeCapabilityDenial(out.text);
          if (!cleaned) cleaned = out.text;
          return {
            text: cleaned,
            model: m.label +
              (webMode ? (deepUsed ? ' · web+stealth' : ' · web') : '') +
              (codeMode ? ' · code' : ''),
            provider: provider.id,
            attempts: attempts,
            web: webMode,
            deep: deepUsed,
            search_hits: searchHitCount,
            continuations: out.continuations || 0
          };
        }
        attempts.push({ endpoint: m.model, error: 'empty' });
      } catch (e) {
        attempts.push({ endpoint: m.model, error: e.message });
      }
    }
  }
  return { text: null, model: null, provider: null, attempts: attempts, web: webMode, deep: deepUsed, search_hits: searchHitCount };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed. Use POST.' }); return; }
    var body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    var message = String(body.message || '').trim();
    var prefs = (body.prefs && typeof body.prefs === 'object') ? body.prefs : {};
    var memory = (body.memory && typeof body.memory === 'object') ? body.memory : null;
    var token = String(body.token || '').trim();
    var mcpTools = normalizeMcpTools(body.mcp_tools);
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
      var analyzed = await analyzeAttachment(message, attachment, history, prefs, function (msg, hist, pr, mem, opts) {
        return tryGenerateAnswer(msg, hist, pr, mem || memory, opts || { web: false });
      });
      res.status(200).json({
        ok: true, agent_id: 'analyze', endpoint: 'vision.analyze',
        params: { name: attachment.name, type: attachment.type, kind: attachment.kind },
        reasoning: 'Attachment analysis / file edit',
        thinking: analyzed.thinking || null, thinking_ms: Date.now() - t0,
        server_executed: true, result: analyzed.text,
        model_used: analyzed.model, provider: analyzed.provider, attempts: analyzed.attempts || [],
        memory_retrieved: !!(memory && memory.retrieved),
        memory_hits: (memory && memory.hit_count) || 0
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
      var genBrowse = await tryGenerateAnswer(message + '\n\n(Browse unavailable this turn. Answer from web context if any.)', history, prefs, memory, { web: true });
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
      var useWeb = forceWeb || route.agent_id === 'web' || wantsWeb(message);
      var gen = await tryGenerateAnswer(message, history, prefs, memory, {
        web: useWeb, code: isCodeTask(message), edit: isEditTask(message)
      });
      res.status(200).json({
        ok: true,
        agent_id: useWeb ? 'web' : route.agent_id,
        endpoint: useWeb ? 'web.search' : route.endpoint,
        params: route.params || {},
        reasoning: useWeb
          ? (gen.deep ? 'Web + Kernel stealth page extract' : (route.reasoning || 'Web-enabled answer'))
          : route.reasoning,
        thinking: route.thinking, thinking_ms: 0,
        server_executed: !!gen.text,
        result: gen.text || 'No model answered. Check API keys (ZAI / VINCI / OPENROUTER).',
        model_used: gen.model, provider: gen.provider, attempts: gen.attempts || [],
        web: !!gen.web, deep: !!gen.deep, search_hits: gen.search_hits || 0,
        continuations: gen.continuations || 0,
        memory_retrieved: !!(memory && memory.retrieved),
        memory_hits: (memory && memory.hit_count) || 0
      });
      return;
    }

    res.status(200).json({
      ok: true, agent_id: route.agent_id, endpoint: route.endpoint,
      params: route.params || {}, reasoning: route.reasoning,
      thinking: route.thinking, thinking_ms: 0, server_executed: false
    });
  } catch (err) {
    console.error('[master]', err);
    res.status(500).json({ error: String(err && err.message ? err.message : err).slice(0, 300) });
  }
};

module.exports.config = { maxDuration: 120 };
