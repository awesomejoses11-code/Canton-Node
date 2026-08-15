/* api/master.js — compact master (chat + vision + web search + memory + browse) */
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const VINCI_URL = 'https://vinci.getsimpledirect.com/api/v1/chat/completions';
const HF_URL = 'https://router.huggingface.co/v1/chat/completions';
const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
var analyzeAttachment = require('../lib/analyze-attachment').analyzeAttachment;
var kernelLib = null;
try { kernelLib = require('../lib/kernel-lib'); } catch (_) { kernelLib = null; }

/** Output budget: ~4x prior (2000/2500). Models may clamp to their own max. */
const MAX_TOKENS_CHAT = 8000;
const MAX_TOKENS_WEB = 10000;
const HISTORY_MSG_CHARS = 4000;

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
      serverId: t.serverId,
      serverName: t.serverName,
      name: t.name,
      description: String(t.description || '').slice(0, 200)
    };
  }).filter(function (t) { return t.name; });
}

function buildThinking(message, route) {
  return [
    '1. Understood: "' + String(message || '').replace(/\s+/g, ' ').trim().slice(0, 120) + '"',
    '2. Route → ' + (route && route.agent_id ? route.agent_id : 'chat'),
    '3. Execute path prepared; format the final answer for a human reader.'
  ].join('\n');
}

function wantsWeb(message) {
  var m = String(message || '').toLowerCase();
  if (/\b(web search|search the web|google|look up|lookup|browse the web|internet search)\b/.test(m)) return true;
  if (/\b(latest|current|today'?s|right now|as of|live|real[- ]?time)\b/.test(m)) return true;
  if (/\b(news|price of|stock|who is|what is happening|weather in)\b/.test(m)) return true;
  if (/\b(have you forgotten|can you search|use (your )?web|search (online|the net))\b/.test(m)) return true;
  if (/\b(dex|debank|gecko|coingecko|token (address|contract)|on[- ]chain)\b/.test(m)) return true;
  if (/\b(origin of|meme|what is this)\b/.test(m)) return true;
  if (/\b(how do i fix|invalid_token|oauth)\b/.test(m)) return true;
  return false;
}

function heuristicRoute(message, mcpTools) {
  var m = message.toLowerCase();
  if (/\b(ocr|read (the )?text|extract text|describe (this |the )?(image|photo)|analyze (this |the )?(image|photo|screenshot)|image.?to.?html|website from image|image website)\b/.test(m))
    return { agent_id: 'analyze', endpoint: 'vision.analyze', params: { prompt: message }, reasoning: 'Heuristic: vision/OCR' };
  if (/\b(video|clip|animation|footage|text.?to.?video)\b/.test(m))
    return { agent_id: 'video', endpoint: 'video.create', params: { prompt: message }, reasoning: 'Heuristic: video' };
  if (/\b(search (for )?(images?|photos?|pictures?)|find (me )?(images?|photos?)|image search)\b/i.test(m))
    return { agent_id: 'image', endpoint: 'image.genimage', params: { prompt: message, stock: true }, reasoning: 'Heuristic: image search' };
  if (/\b(image|logo|picture|photo|draw|illustration|txt2img|generate (an? )?image)\b/.test(m))
    return { agent_id: 'image', endpoint: 'image.genimage', params: { prompt: message }, reasoning: 'Heuristic: image' };
  if (/\b(music|song|melody|compose)\b/.test(m))
    return { agent_id: 'music', endpoint: 'music.aimelody', params: { prompt: message }, reasoning: 'Heuristic: music' };
  if (/\b(tts|speak|voice|text.to.speech)\b/.test(m))
    return { agent_id: 'tts', endpoint: 'tts.default', params: { text: message }, reasoning: 'Heuristic: TTS' };
  // Browse only when a URL is present or user clearly asks to open a page
  if ((/\b(browse|visit|scrape)\b/.test(m) && /https?:\/\//.test(message)) ||
      (/https?:\/\//.test(message) && /\b(open (this |the )?url|read (this |the )?page|scrape)\b/.test(m)))
    return { agent_id: 'browse', endpoint: 'kernel.browse', params: { prompt: message }, reasoning: 'Heuristic: browse' };
  if (wantsWeb(message))
    return { agent_id: 'web', endpoint: 'web.search', params: { prompt: message, web: true }, reasoning: 'Heuristic: web search' };
  if (mcpTools && mcpTools.length) {
    var isErrorHelp = /\b(401|403|invalid_token|oauth|how do i fix|error|failed|unauthorized)\b/i.test(m);
    var wantsMcpTool = /\b(use (my |the )?mcp|call (my |the )?mcp|run (my |the )?mcp|via mcp|mcp tool|invoke (the )?tool)\b/i.test(m);
    var wantsPrice = /\b(price of|how much is|what is .+ worth)\b/i.test(m) ||
      (/\b(bitcoin|btc|ethereum|eth|solana|sol)\b/i.test(m) && /\b(price|worth|cost)\b/i.test(m)) ||
      /\bcoingecko\b/i.test(m);
    if (!isErrorHelp && (wantsMcpTool || wantsPrice)) {
      var pick = mcpTools.find(function (x) { return x.name === 'execute'; }) || mcpTools[0];
      return {
        agent_id: 'mcp',
        endpoint: 'mcp.call',
        params: { serverId: pick.serverId, tool: pick.name, prompt: message },
        reasoning: wantsPrice ? 'Heuristic: crypto price via MCP' : 'Heuristic: explicit MCP tool'
      };
    }
  }
  return null;
}

async function duckDuckGoSearch(query) {
  try {
    var q = encodeURIComponent(String(query || '').slice(0, 200));
    var url = 'https://html.duckduckgo.com/html/?q=' + q;
    var resp = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CantonNode/1.0)', Accept: 'text/html' },
      signal: AbortSignal.timeout(12000)
    });
    if (!resp.ok) return '';
    var html = await resp.text();
    var results = [];
    var re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    var snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/gi;
    var m;
    while ((m = re.exec(html)) && results.length < 5) {
      var href = m[1];
      var title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      var uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch (_) {} }
      results.push({ title: title, url: href });
    }
    var snippets = [];
    while ((m = snipRe.exec(html)) && snippets.length < 5) {
      snippets.push(String(m[1] || m[2] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    }
    if (!results.length) return '';
    var lines = ['Web search results (DuckDuckGo):'];
    for (var i = 0; i < results.length; i++) {
      lines.push((i + 1) + '. **' + results[i].title + '**');
      lines.push('   ' + results[i].url);
      if (snippets[i]) lines.push('   ' + snippets[i].slice(0, 240));
    }
    return lines.join('\n');
  } catch (_) { return ''; }
}

function buildChatSystemPrompt(prefs, memory, webMode) {
  var name = (prefs && prefs.displayName) ? String(prefs.displayName).trim() : '';
  var tone = (prefs && prefs.tone) ? String(prefs.tone) : 'friendly';
  var lines = [
    'You are the Canton Node Master Agent — a multi-tool assistant.',
    'Capabilities: chat, image/video/music/TTS, vision, web search, page browse, MCP tools when requested, silent memory.',
    'Never claim you lack web search or tools when this system is providing them.',
    'Answer in clean standard Markdown. Do not dump raw JSON unless asked.',
    'Finish complete answers. Never stop mid-sentence or mid-list; use the full output budget when the user needs depth.'
  ];
  if (webMode) lines.push('Use provided search results; do not invent URLs or prices.');
  if (name) lines.push('Address the user as "' + name.replace(/"/g, '') + '" when natural.');
  lines.push('Reply tone: ' + tone + '.');
  if (memory && memory.enabled) {
    if (memory.reference) {
      lines.push('--- Agent reference ---');
      lines.push(String(memory.reference).slice(0, 6000));
    }
    if (memory.user_logs) {
      lines.push('--- User log ---');
      lines.push(String(memory.user_logs).slice(0, 6000));
    }
  }
  return lines.join('\n');
}

async function tryGenerateAnswer(message, history, prefs, memory, opts) {
  opts = opts || {};
  var webMode = !!opts.web;
  var attempts = [];
  var prior = (history || []).slice(-8);
  var userContent = message;

  if (webMode) {
    var orKey = process.env.OPENROUTER_API_KEY;
    if (orKey) {
      var orModels = ['meta-llama/llama-3.3-70b-instruct:free', 'google/gemma-4-31b-it:free'];
      for (var oi = 0; oi < orModels.length; oi++) {
        try {
          var orBody = {
            model: orModels[oi],
            messages: [{ role: 'system', content: buildChatSystemPrompt(prefs || {}, memory || null, true) }]
              .concat(prior).concat([{ role: 'user', content: message }]),
            max_tokens: MAX_TOKENS_WEB,
            plugins: [{ id: 'web', max_results: 5 }]
          };
          var orResp = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: authHeaders({ id: 'openrouter' }, orKey),
            body: JSON.stringify(orBody),
            signal: AbortSignal.timeout(90000)
          });
          if (orResp.ok) {
            var orData = await orResp.json();
            var orMsg = orData && orData.choices && orData.choices[0] && orData.choices[0].message;
            var orText = orMsg && typeof orMsg.content === 'string' ? orMsg.content.trim() : '';
            if (orText) {
              return { text: orText, model: 'OR web · ' + orModels[oi].split('/')[1], provider: 'openrouter', attempts: attempts, web: true };
            }
            attempts.push({ endpoint: orModels[oi] + '+web', error: 'empty' });
          } else attempts.push({ endpoint: orModels[oi] + '+web', error: 'HTTP ' + orResp.status });
        } catch (e) { attempts.push({ endpoint: orModels[oi] + '+web', error: e.message }); }
      }
    } else attempts.push({ endpoint: 'openrouter+web', error: 'key missing' });

    var searchNote = await duckDuckGoSearch(message);
    if (searchNote) {
      userContent = message + '\n\n---\n' + searchNote + '\n---\nUse the search results above. Cite links in Markdown.';
    } else attempts.push({ endpoint: 'duckduckgo', error: 'no results' });
  }

  var system = buildChatSystemPrompt(prefs || {}, memory || null, webMode);
  var chain = orderedLlmChain(prefs || {});
  for (var pi = 0; pi < chain.length; pi++) {
    var provider = chain[pi];
    var apiKey = providerApiKey(provider);
    if (!apiKey) { attempts.push({ endpoint: provider.id, error: 'key missing' }); continue; }
    for (var mi = 0; mi < provider.models.length; mi++) {
      var m = provider.models[mi];
      try {
        var messages = [{ role: 'system', content: system }].concat(prior).concat([{ role: 'user', content: userContent }]);
        var body = { model: m.model, messages: messages, max_tokens: webMode ? MAX_TOKENS_WEB : MAX_TOKENS_CHAT };
        if (webMode && provider.id === 'openrouter') body.plugins = [{ id: 'web', max_results: 5 }];
        var resp = await fetch(provider.url, {
          method: 'POST',
          headers: authHeaders(provider, apiKey),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(webMode ? 90000 : 60000)
        });
        if (!resp.ok) { attempts.push({ endpoint: m.model, error: 'HTTP ' + resp.status }); continue; }
        var data = await resp.json();
        var msg = data && data.choices && data.choices[0] && data.choices[0].message;
        var text = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
        if (text) {
          return { text: text, model: m.label + (webMode ? ' · web' : ''), provider: provider.id, attempts: attempts, web: webMode };
        }
        attempts.push({ endpoint: m.model, error: 'empty' });
      } catch (e) { attempts.push({ endpoint: m.model, error: e.message }); }
    }
  }
  return { text: null, model: null, provider: null, attempts: attempts, web: webMode };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed. Use POST.' }); return; }
    var body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    var message = String(body.message || '').trim();
    var prefs = (body.prefs && typeof body.prefs === 'object') ? body.prefs : {};
    var memory = (body.memory && typeof body.memory === 'object') ? body.memory : null;
    var mcpTools = normalizeMcpTools(body.mcp_tools);
    var attachment = body.attachment || null;
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
    if (attachment && (attachment.dataUrl || attachment.text)) {
      var t0 = Date.now();
      var analyzed = await analyzeAttachment(message, attachment, history, prefs, function (msg, hist, pr, mem, opts) {
        return tryGenerateAnswer(msg, hist, pr, mem, opts || { web: false });
      });
      res.status(200).json({
        ok: true, agent_id: 'analyze', endpoint: 'vision.analyze',
        params: { name: attachment.name, type: attachment.type, kind: attachment.kind },
        reasoning: 'Attachment analysis (OCR / vision / text)',
        thinking: analyzed.thinking || null, thinking_ms: Date.now() - t0,
        server_executed: true, result: analyzed.text,
        model_used: analyzed.model, provider: analyzed.provider, attempts: analyzed.attempts || []
      });
      return;
    }
    var route = heuristicRoute(message, mcpTools);
    if (!route) route = { agent_id: 'chat', endpoint: 'chat.answer', params: { prompt: message }, reasoning: 'Default chat' };
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
          if (k && k.error && /No URL found/i.test(k.error)) {
            res.status(200).json({
              ok: true, agent_id: 'chat', endpoint: 'chat.answer',
              thinking: route.thinking, thinking_ms: Date.now() - tBrowse,
              server_executed: true,
              result: k.error + '\n\nExample: Browse https://docs.example.com/getting-started',
              reasoning: 'Browse needs a URL'
            });
            return;
          }
        }
      } catch (browseErr) {
        console.error('[master browse]', browseErr);
      }
      var genBrowse = await tryGenerateAnswer(
        message + '\n\n(Browse tool could not load the page. Summarize from web search if possible.)',
        history, prefs, memory, { web: true }
      );
      res.status(200).json({
        ok: true,
        agent_id: 'web',
        endpoint: 'web.search',
        thinking: route.thinking,
        thinking_ms: Date.now() - tBrowse,
        server_executed: !!genBrowse.text,
        result: genBrowse.text || 'Could not browse the page. Paste a full https:// URL and try again.',
        model_used: genBrowse.model,
        provider: genBrowse.provider,
        reasoning: 'Browse fallback → web'
      });
      return;
    }

    if (route.agent_id === 'chat' || route.agent_id === 'web' || route.agent_id === 'analyze') {
      var useWeb = route.agent_id === 'web' || wantsWeb(message);
      var gen = await tryGenerateAnswer(message, history, prefs, memory, { web: useWeb });
      res.status(200).json({
        ok: true,
        agent_id: useWeb ? 'web' : route.agent_id,
        endpoint: useWeb ? 'web.search' : route.endpoint,
        params: route.params || {},
        reasoning: useWeb ? (route.reasoning || 'Web-enabled answer') : route.reasoning,
        thinking: route.thinking,
        thinking_ms: 0,
        server_executed: !!gen.text,
        result: gen.text || 'No model answered. Check API keys (ZAI / VINCI / OPENROUTER) and try again.',
        model_used: gen.model,
        provider: gen.provider,
        attempts: gen.attempts || [],
        web: !!gen.web
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

module.exports.config = { maxDuration: 90 };
