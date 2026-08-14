/* api/master.js — compact master (Chrome-safe restore + attachment analyze) */
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const VINCI_URL = 'https://vinci.getsimpledirect.com/api/v1/chat/completions';
const HF_URL = 'https://router.huggingface.co/v1/chat/completions';
var analyzeAttachment = require('./analyze-attachment').analyzeAttachment;
var kernelLib = null;
try { kernelLib = require('./kernel-lib'); } catch (_) { kernelLib = null; }

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

async function safeText(resp) {
  try { return await resp.text(); } catch (_) { return ''; }
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
  var lines = [
    '1. Understood: "' + String(message || '').replace(/\s+/g, ' ').trim().slice(0, 120) + '"',
    '2. Route → ' + (route && route.agent_id ? route.agent_id : 'chat'),
    '3. Execute path prepared; format the final answer for a human reader.'
  ];
  return lines.join('\n');
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
  if (/\b(search the web|look up|latest news|current events)\b/.test(m))
    return { agent_id: 'web', endpoint: 'chat.askgpt5', params: { prompt: message, web: true }, reasoning: 'Heuristic: web' };
  if (mcpTools && mcpTools.length) {
    var wants = /\b(coingecko|mcp|price|crypto|bitcoin|btc|ethereum)\b/i.test(message);
    if (wants) {
      var pick = mcpTools.find(function (x) { return x.name === 'execute'; }) || mcpTools[0];
      return { agent_id: 'mcp', endpoint: 'mcp.call', params: { serverId: pick.serverId, tool: pick.name }, reasoning: 'Heuristic: MCP' };
    }
  }
  return null;
}

async function tryGenerateAnswer(message, history, prefs) {
  var attempts = [];
  var prior = (history || []).slice(-8);
  for (var pi = 0; pi < LLM_CHAIN.length; pi++) {
    var provider = LLM_CHAIN[pi];
    var apiKey = process.env[provider.envKey];
    if (!apiKey) { attempts.push({ endpoint: provider.id, error: 'key missing' }); continue; }
    for (var mi = 0; mi < provider.models.length; mi++) {
      var m = provider.models[mi];
      try {
        var messages = [
          { role: 'system', content: 'You are the Canton Node Master Agent. Be clear and helpful. Tools exist for image/video/music/TTS/MCP/browse.' }
        ].concat(prior).concat([{ role: 'user', content: message }]);
        var resp = await fetch(provider.url, {
          method: 'POST',
          headers: authHeaders(provider, apiKey),
          body: JSON.stringify({ model: m.model, messages: messages, max_tokens: 800 }),
          signal: AbortSignal.timeout(45000)
        });
        if (!resp.ok) {
          attempts.push({ endpoint: m.model, error: 'HTTP ' + resp.status });
          continue;
        }
        var data = await resp.json();
        var msg = data && data.choices && data.choices[0] && data.choices[0].message;
        var text = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
        if (text) return { text: text, model: m.label, provider: provider.id, attempts: attempts };
        attempts.push({ endpoint: m.model, error: 'empty' });
      } catch (e) {
        attempts.push({ endpoint: m.model, error: e.message });
      }
    }
  }
  return { text: null, model: null, provider: null, attempts: attempts };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed. Use POST.' });
      return;
    }
    var body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    var message = String(body.message || '').trim();
    var prefs = (body.prefs && typeof body.prefs === 'object') ? body.prefs : {};
    var mcpTools = normalizeMcpTools(body.mcp_tools);
    var attachment = body.attachment || null;
    var history = [];
    if (Array.isArray(body.history)) {
      history = body.history
        .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; })
        .slice(-12)
        .map(function (m) { return { role: m.role, content: String(m.content).slice(0, 2000); }; });
    }

    if (!message && !(attachment && (attachment.dataUrl || attachment.text))) {
      res.status(400).json({ error: 'Missing "message" (or attach a file).' });
      return;
    }
    if (!message && attachment) {
      message = attachment.kind === 'image'
        ? 'Analyze this image. Describe it, OCR any text, and note important details.'
        : 'Analyze this file and summarize the important points.';
    }

    if (attachment && (attachment.dataUrl || attachment.text)) {
      var t0 = Date.now();
      var analyzed = await analyzeAttachment(message, attachment, history, prefs, tryGenerateAnswer);
      res.status(200).json({
        ok: true,
        agent_id: 'analyze',
        endpoint: 'vision.analyze',
        params: { name: attachment.name, type: attachment.type, kind: attachment.kind },
        reasoning: 'Attachment analysis (OCR / vision / text)',
        thinking: analyzed.thinking || null,
        thinking_ms: Date.now() - t0,
        server_executed: true,
        result: analyzed.text,
        model_used: analyzed.model,
        provider: analyzed.provider,
        attempts: analyzed.attempts || []
      });
      return;
    }

    var route = heuristicRoute(message, mcpTools);
    if (!route) {
      route = { agent_id: 'chat', endpoint: 'chat.answer', params: { prompt: message }, reasoning: 'Default chat' };
    }
    route.thinking = buildThinking(message, route);

    if (route.agent_id === 'browse' && kernelLib && kernelLib.tryKernelBrowse) {
      try {
        var k = await kernelLib.tryKernelBrowse(message);
        if (k && k.ok) {
          res.status(200).json({
            ok: true, agent_id: 'browse', endpoint: 'kernel.browse',
            thinking: route.thinking, thinking_ms: 0,
            server_executed: true, result: k.text || k.result,
            reasoning: route.reasoning
          });
          return;
        }
      } catch (_) {}
    }

    if (route.agent_id === 'chat' || route.agent_id === 'web' || route.agent_id === 'analyze') {
      var gen = await tryGenerateAnswer(message, history, prefs);
      res.status(200).json({
        ok: true,
        agent_id: route.agent_id,
        endpoint: route.endpoint,
        params: route.params || {},
        reasoning: route.reasoning,
        thinking: route.thinking,
        thinking_ms: 0,
        server_executed: !!gen.text,
        result: gen.text || 'No model answered. Check API keys.',
        model_used: gen.model,
        provider: gen.provider,
        attempts: gen.attempts || []
      });
      return;
    }

    res.status(200).json({
      ok: true,
      agent_id: route.agent_id,
      endpoint: route.endpoint,
      params: route.params || {},
      reasoning: route.reasoning,
      thinking: route.thinking,
      thinking_ms: 0,
      server_executed: false
    });
  } catch (err) {
    console.error('[master]', err);
    res.status(500).json({ error: String(err && err.message ? err.message : err).slice(0, 300) });
  }
};

module.exports.config = { maxDuration: 60 };
