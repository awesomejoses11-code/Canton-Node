/* api/master.js — compact master (chat + vision + web search + memory + browse)
 *
 * Anti-truncation (2026-08-16):
 *   • High max_tokens for chat/web/code
 *   • Automatic continuation when finish_reason is "length"
 *   • System rules forbid incomplete code / mid-answer stops
 *   • Reference memory is injected and models are told to apply it
 */
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const VINCI_URL = 'https://vinci.getsimpledirect.com/api/v1/chat/completions';
const HF_URL = 'https://router.huggingface.co/v1/chat/completions';
const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
var analyzeAttachment = require('../lib/analyze-attachment').analyzeAttachment;
var kernelLib = null;
try { kernelLib = require('../lib/kernel-lib'); } catch (_) { kernelLib = null; }

/** Output budgets — models may clamp to their own max; we never ask for less. */
const MAX_TOKENS_CHAT = 12000;
const MAX_TOKENS_WEB = 12000;
const MAX_TOKENS_CODE = 16000;
const HISTORY_MSG_CHARS = 8000;
const REF_CHARS = 12000;
const LOG_CHARS = 8000;
/** Max auto-continuations when the model hits the token wall. */
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
    '3. Execute path prepared; deliver a complete, non-truncated final answer.'
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

function isCodeTask(message) {
  var m = String(message || '').toLowerCase();
  if (/\b(code|coding|program|script|function|class|module|api|endpoint|refactor|bug|debug|implement|write (a |the )?(full |complete )?(app|file|script|function|class|component))\b/.test(m)) return true;
  if (/\b(javascript|typescript|python|java|rust|go|c\+\+|sql|html|css|react|node\.?js|vue|svelte)\b/.test(m)) return true;
  if (/\b(```|diff|pull request|unit test|test suite|makefile|dockerfile|package\.json)\b/.test(m)) return true;
  if (/\b(complete (the )?code|full (source|implementation)|no placeholders|do not truncate)\b/.test(m)) return true;
  return false;
}

function looksTruncated(text, finishReason) {
  if (finishReason === 'length' || finishReason === 'max_tokens') return true;
  var s = String(text || '').trim();
  if (!s) return false;
  var fences = (s.match(/```/g) || []).length;
  if (fences % 2 === 1) return true;
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

function buildChatSystemPrompt(prefs, memory, webMode, codeMode) {
  var name = (prefs && prefs.displayName) ? String(prefs.displayName).trim() : '';
  var tone = (prefs && prefs.tone) ? String(prefs.tone) : 'friendly';
  var lines = [
    'You are the Canton Node Master Agent — a multi-tool assistant.',
    'Capabilities: chat, image/video/music/TTS, vision, web search, page browse, MCP tools when requested, silent memory.',
    'Never claim you lack web search or tools when this system is providing them.',
    'Answer in clean standard Markdown. Do not dump raw JSON unless asked.',
    '',
    'COMPLETENESS (mandatory):',
    '- Never truncate. Never stop mid-sentence, mid-list, or mid-function.',
    '- Prefer one complete deliverable over a partial sketch.',
    '- If space is tight, finish the current section fully rather than starting a new incomplete one.',
    '- Do not write "..." / "rest omitted" / "continues" / "TODO: implement" as a substitute for real content.'
  ];
  if (codeMode) {
    lines.push(
      '',
      'CODING RULES (mandatory):',
      '- Output complete, runnable code. Close every brace, parenthesis, and markdown fence.',
      '- No placeholders like // ... rest of code, pass, or NotImplemented unless the user explicitly asked for a stub.',
      '- If multiple files are needed, include each full file in its own fenced block with a clear path comment.',
      '- Apply patterns, APIs, and conventions from the Agent reference section when present — learn from it while solving this task.'
    );
  }
  if (webMode) lines.push('Use provided search results; do not invent URLs or prices.');
  if (name) lines.push('Address the user as "' + name.replace(/"/g, '') + '" when natural.');
  lines.push('Reply tone: ' + tone + '.');
  if (memory && memory.enabled) {
    if (memory.reference) {
      lines.push('');
      lines.push('--- Agent reference (use this knowledge while performing the task) ---');
      lines.push(String(memory.reference).slice(0, REF_CHARS));
      lines.push('--- End agent reference ---');
      lines.push('When the reference is relevant, apply it. Do not ignore project conventions documented there.');
    }
    if (memory.user_logs) {
      lines.push('--- User log ---');
      lines.push(String(memory.user_logs).slice(0, LOG_CHARS));
      lines.push('--- End user log ---');
    }
  }
  return lines.join('\n');
}

async function callOnce(provider, apiKey, modelCfg, messages, maxTokens, webPlugin) {
  var body = {
    model: modelCfg.model,
    messages: messages,
    max_tokens: maxTokens
  };
  if (webPlugin && provider.id === 'openrouter') {
    body.plugins = [{ id: 'web', max_results: 5 }];
  }
  var resp = await fetch(provider.url, {
    method: 'POST',
    headers: authHeaders(provider, apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000)
  });
  if (!resp.ok) {
    var err = new Error('HTTP ' + resp.status);
    err.status = resp.status;
    throw err;
  }
  var data = await resp.json();
  var choice = data && data.choices && data.choices[0];
  var msg = choice && choice.message;
  var text = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
  var finishReason = (choice && (choice.finish_reason || choice.native_finish_reason)) || '';
  return { text: text, finishReason: String(finishReason || '').toLowerCase() };
}

async function generateWithContinuation(provider, apiKey, modelCfg, system, prior, userContent, maxTokens, webPlugin) {
  var messages = [{ role: 'system', content: system }]
    .concat(prior || [])
    .concat([{ role: 'user', content: userContent }]);

  var first = await callOnce(provider, apiKey, modelCfg, messages, maxTokens, webPlugin);
  if (!first.text) return first;

  var full = first.text;
  var finish = first.finishReason;
  var cont = 0;

  while (cont < MAX_CONTINUATIONS && looksTruncated(full, finish)) {
    cont++;
    var contMessages = messages.concat([
      { role: 'assistant', content: full },
      {
        role: 'user',
        content:
          'Continue exactly from where you left off. ' +
          'Do not repeat earlier content. Close any open code fences or blocks. ' +
          'Deliver the remainder until the answer is fully complete.'
      }
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
  var codeMode = !!opts.code || isCodeTask(message);
  var attempts = [];
  var prior = (history || []).slice(-8);
  var userContent = message;
  var maxTokens = codeMode ? MAX_TOKENS_CODE : (webMode ? MAX_TOKENS_WEB : MAX_TOKENS_CHAT);

  if (webMode) {
    var orKey = process.env.OPENROUTER_API_KEY;
    if (orKey) {
      var orModels = ['meta-llama/llama-3.3-70b-instruct:free', 'google/gemma-4-31b-it:free'];
      for (var oi = 0; oi < orModels.length; oi++) {
        try {
          var orProv = { id: 'openrouter', url: OPENROUTER_URL };
          var orCfg = { model: orModels[oi], label: orModels[oi] };
          var systemOr = buildChatSystemPrompt(prefs || {}, memory || null, true, codeMode);
          var outOr = await generateWithContinuation(
            orProv, orKey, orCfg, systemOr, prior, message, maxTokens, true
          );
          if (outOr.text) {
            return {
              text: outOr.text,
              model: 'OR web · ' + orModels[oi].split('/')[1],
              provider: 'openrouter',
              attempts: attempts,
              web: true,
              continuations: outOr.continuations || 0
            };
          }
          attempts.push({ endpoint: orModels[oi] + '+web', error: 'empty' });
        } catch (e) {
          attempts.push({ endpoint: orModels[oi] + '+web', error: e.message });
        }
      }
    } else attempts.push({ endpoint: 'openrouter+web', error: 'key missing' });

    var searchNote = await duckDuckGoSearch(message);
    if (searchNote) {
      userContent = message + '\n\n---\n' + searchNote + '\n---\nUse the search results above. Cite links in Markdown.';
    } else attempts.push({ endpoint: 'duckduckgo', error: 'no results' });
  }

  var system = buildChatSystemPrompt(prefs || {}, memory || null, webMode, codeMode);
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
          return {
            text: out.text,
            model: m.label + (webMode ? ' · web' : '') + (codeMode ? ' · code' : ''),
            provider: provider.id,
            attempts: attempts,
            web: webMode,
            continuations: out.continuations || 0
          };
        }
        attempts.push({ endpoint: m.model, error: 'empty' });
      } catch (e) {
        attempts.push({ endpoint: m.model, error: e.message });
      }
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
        return tryGenerateAnswer(msg, hist, pr, mem || memory, opts || { web: false });
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
      var gen = await tryGenerateAnswer(message, history, prefs, memory, {
        web: useWeb,
        code: isCodeTask(message)
      });
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
        web: !!gen.web,
        continuations: gen.continuations || 0
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
