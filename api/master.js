/* api/master.js — compact master (chat + vision + web search + memory) */
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const VINCI_URL = 'https://vinci.getsimpledirect.com/api/v1/chat/completions';
const HF_URL = 'https://router.huggingface.co/v1/chat/completions';
var analyzeAttachment = require('../lib/analyze-attachment').analyzeAttachment;
var kernelLib = null;
try { kernelLib = require('../lib/kernel-lib'); } catch (_) { kernelLib = null; }

const LLM_CHAIN = [
  { id: 'vinci', url: VINCI_URL, envKey: 'VINCI_API_KEY', models: [{ model: 'forte', label: 'Vinci Forte' }] },
  { id: 'openrouter', url: OPENROUTER_URL, envKey: 'OPENROUTER_API_KEY', models: [
    { model: 'meta-llama/llama-3.3-70b-instruct:free', label: 'OR Llama 3.3' },
    { model: 'google/gemma-3-27b-it:free', label: 'OR Gemma 3' }
  ]},
  { id: 'huggingface', url: HF_URL, envKey: 'HF_TOKEN', models: [
    { model: 'Qwen/Qwen2.5-7B-Instruct', label: 'HF Qwen2.5' }
  ]}
];

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
  return false;
}

function heuristicRoute(message, mcpTools) {
  var m = message.toLowerCase();
  if (/\b(ocr|read (the )?text|extract text|describe (this |the )?(image|photo)|analyze (this |the )?(image|photo|screenshot)|image.?to.?html|website from image|image website)\b/.test(m))
    return { agent_id: 'analyze', endpoint: 'vision.analyze', params: { prompt: message }, reasoning: 'Heuristic: vision/OCR' };
  if (/\b(video|clip|animation|footage|text.?to.?video)\b/.test(m))
    return { agent_id: 'video', endpoint: 'video.create', params: { prompt: message }, reasoning: 'Heuristic: video' };
  if (/\b(image|logo|picture|photo|draw|illustration|txt2img|generate (an? )?image)\b/.test(m))
    return { agent_id: 'image', endpoint: 'image.genimage', params: { prompt: message }, reasoning: 'Heuristic: image' };
  if (/\b(music|song|melody|compose)\b/.test(m))
    return { agent_id: 'music', endpoint: 'music.aimelody', params: { prompt: message }, reasoning: 'Heuristic: music' };
  if (/\b(tts|speak|voice|text.to.speech)\b/.test(m))
    return { agent_id: 'tts', endpoint: 'tts.default', params: { text: message }, reasoning: 'Heuristic: TTS' };
  if (/\b(browse|visit (this |the )?page|scrape|open (this |the )?url)\b/.test(m) || (/https?:\/\//.test(message) && /\b(browse|visit|open|scrape|read)\b/.test(m)))
    return { agent_id: 'browse', endpoint: 'kernel.browse', params: { prompt: message }, reasoning: 'Heuristic: browse' };
  if (wantsWeb(message))
    return { agent_id: 'web', endpoint: 'web.search', params: { prompt: message, web: true }, reasoning: 'Heuristic: web search' };
  if (mcpTools && mcpTools.length) {
    var wants = /\b(coingecko|mcp|price|crypto|bitcoin|btc|ethereum)\b/i.test(message);
    if (wants) {
      var pick = mcpTools.find(function (x) { return x.name === 'execute'; }) || mcpTools[0];
      return { agent_id: 'mcp', endpoint: 'mcp.call', params: { serverId: pick.serverId, tool: pick.name }, reasoning: 'Heuristic: MCP' };
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
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CantonNode/1.0)',
        Accept: 'text/html'
      },
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
      if (uddg) {
        try { href = decodeURIComponent(uddg[1]); } catch (_) {}
      }
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
  } catch (_) {
    return '';
  }
}

function buildChatSystemPrompt(prefs, memory, webMode) {
  var name = (prefs && prefs.displayName) ? String(prefs.displayName).trim() : '';
  var tone = (prefs && prefs.tone) ? String(prefs.tone) : 'friendly';
  var lines = [
    'You are the Canton Node Master Agent — a multi-tool assistant.',
    'Capabilities you DO have in this product:',
    '- Chat / reasoning / coding help',
    '- Image, video, music, and TTS generation (client shows Execute when routed)',
    '- File / image analysis (OCR, vision)',
    '- Web search and page browse when the request needs live or online information',
    '- MCP tools the user connected in Settings',
    '- Persistent memory files (reference.md + user_logs.md) injected below when enabled',
    'Never claim you lack web search, browsing, or tools when this system is providing them.',
    'If web search results are included in the user message, ground your answer in them and cite links in Markdown.',
    'Always answer in clean standard Markdown (headings, short paragraphs, bullets when helpful).',
    'Do not dump internal hashes, request IDs, or raw JSON unless the user asks.',
    'If the user asks you to remember something lasting, acknowledge it and restate what you will keep in memory.',
    'Finish complete answers — do not stop mid-sentence or mid-list.'
  ];
  if (webMode) {
    lines.push('This turn requires up-to-date information. Use the provided search results; do not invent URLs or prices.');
  }
  if (name) lines.push('Address the user as "' + name.replace(/"/g, '') + '" when natural.');
  lines.push('Reply tone: ' + tone + '.');
  if (memory && memory.enabled) {
    if (memory.reference) {
      lines.push('--- Agent reference (persistent memory) ---');
      lines.push(String(memory.reference).slice(0, 6000));
    }
    if (memory.user_logs) {
      lines.push('--- User log / preferences (persistent memory) ---');
      lines.push(String(memory.user_logs).slice(0, 6000));
    }
    lines.push('Respect preferences and custom commands from the user log when relevant.');
  }
  return lines.join('\n');
}

async function tryGenerateAnswer(message, history, prefs, memory, opts) {
  opts = opts || {};
  var webMode = !!opts.web;
  var attempts = [];
  var prior = (history || []).slice(-8);
  var userContent = message;
  var searchNote = '';

  if (webMode) {
    var orKey = process.env.OPENROUTER_API_KEY;
    if (orKey) {
      var orModels = [
        'meta-llama/llama-3.3-70b-instruct:free',
        'google/gemma-3-27b-it:free'
      ];
      for (var oi = 0; oi < orModels.length; oi++) {
        try {
          var orBody = {
            model: orModels[oi],
            messages: [
              { role: 'system', content: buildChatSystemPrompt(prefs || {}, memory || null, true) }
            ].concat(prior).concat([{ role: 'user', content: message }]),
            max_tokens: 2500,
            plugins: [{ id: 'web', max_results: 5 }]
          };
          var orResp = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: authHeaders({ id: 'openrouter' }, orKey),
            body: JSON.stringify(orBody),
            signal: AbortSignal.timeout(60000)
          });
          if (orResp.ok) {
            var orData = await orResp.json();
            var orMsg = orData && orData.choices && orData.choices[0] && orData.choices[0].message;
            var orText = orMsg && typeof orMsg.content === 'string' ? orMsg.content.trim() : '';
            if (orText) {
              return {
                text: orText,
                model: 'OR web · ' + orModels[oi].split('/')[1],
                provider: 'openrouter',
                attempts: attempts,
                web: true
              };
            }
            attempts.push({ endpoint: orModels[oi] + '+web', error: 'empty' });
          } else {
            attempts.push({ endpoint: orModels[oi] + '+web', error: 'HTTP ' + orResp.status });
          }
        } catch (e) {
          attempts.push({ endpoint: orModels[oi] + '+web', error: e.message });
        }
      }
    } else {
      attempts.push({ endpoint: 'openrouter+web', error: 'key missing' });
    }

    searchNote = await duckDuckGoSearch(message);
    if (searchNote) {
      userContent =
        message +
        '\n\n---\n' +
        searchNote +
        '\n---\nUse the search results above. Cite links in Markdown. If results are thin, say what is missing.';
    } else {
      attempts.push({ endpoint: 'duckduckgo', error: 'no results' });
    }
  }

  var system = buildChatSystemPrompt(prefs || {}, memory || null, webMode);
  for (var pi = 0; pi < LLM_CHAIN.length; pi++) {
    var provider = LLM_CHAIN[pi];
    var apiKey = process.env[provider.envKey];
    if (!apiKey) { attempts.push({ endpoint: provider.id, error: 'key missing' }); continue; }
    for (var mi = 0; mi < provider.models.length; mi++) {
      var m = provider.models[mi];
      try {
        var messages = [{ role: 'system', content: system }].concat(prior).concat([{ role: 'user', content: userContent }]);
        var body = { model: m.model, messages: messages, max_tokens: webMode ? 2500 : 2000 };
        if (webMode && provider.id === 'openrouter') {
          body.plugins = [{ id: 'web', max_results: 5 }];
        }
        var resp = await fetch(provider.url, {
          method: 'POST',
          headers: authHeaders(provider, apiKey),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(webMode ? 60000 : 45000)
        });
        if (!resp.ok) { attempts.push({ endpoint: m.model, error: 'HTTP ' + resp.status }); continue; }
        var data = await resp.json();
        var msg = data && data.choices && data.choices[0] && data.choices[0].message;
        var text = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
        if (text) {
          return {
            text: text,
            model: m.label + (webMode ? ' · web' : ''),
            provider: provider.id,
            attempts: attempts,
            web: webMode
          };
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
        .map(function (m) { return { role: m.role, content: String(m.content).slice(0, 2000) }; });
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
      var analyzed = await analyzeAttachment(message, attachment, history, prefs, function (msg, hist, pr, mem) {
        return tryGenerateAnswer(msg, hist, pr, mem, { web: false });
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

    if (route.agent_id === 'browse' && kernelLib && kernelLib.tryKernelBrowse) {
      try {
        var k = await kernelLib.tryKernelBrowse(message);
        if (k && k.ok) {
          res.status(200).json({
            ok: true, agent_id: 'browse', endpoint: 'kernel.browse',
            thinking: route.thinking, thinking_ms: 0,
            server_executed: true, result: k.text || k.result, reasoning: route.reasoning
          });
          return;
        }
      } catch (_) {}
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
        result: gen.text || 'No model answered. Check API keys (VINCI / OPENROUTER) and try again.',
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

module.exports.config = { maxDuration: 60 };
