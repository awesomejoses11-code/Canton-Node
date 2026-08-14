/* =========================================================================
 * api/master.js — Master Agent router
 *
 * Priority: heuristic → Vinci → OpenRouter → HF
 * Chat/web: history[] + prefs { displayName, tone }
 * MCP: client sends mcp_tools[] from MCPClient.getEnabledTools(email)
 * ========================================================================= */

const VINCI_URL = 'https://vinci.getsimpledirect.com/api/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const HF_URL = 'https://router.huggingface.co/v1/chat/completions';

const LLM_CHAIN = [
  {
    id: 'vinci',
    label: 'Vinci Forte',
    url: VINCI_URL,
    envKey: 'VINCI_API_KEY',
    models: [{ model: 'forte', label: 'Vinci Forte' }, { model: 'mezzo', label: 'Vinci Mezzo' }]
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    url: OPENROUTER_URL,
    envKey: 'OPENROUTER_API_KEY',
    models: [
      { model: 'meta-llama/llama-3.3-70b-instruct:free', label: 'OR Llama 3.3 70B' },
      { model: 'google/gemma-3-27b-it:free', label: 'OR Gemma 3 27B' },
      { model: 'qwen/qwen-2.5-72b-instruct:free', label: 'OR Qwen 2.5 72B' },
      { model: 'openai/gpt-oss-20b:free', label: 'OR GPT-OSS 20B' }
    ]
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    url: HF_URL,
    envKey: 'HF_TOKEN',
    models: [
      { model: 'Qwen/Qwen2.5-7B-Instruct', label: 'HF Qwen2.5 7B' },
      { model: 'meta-llama/Llama-3.1-8B-Instruct', label: 'HF Llama 3.1 8B' }
    ]
  }
];

const ENDPOINT_TO_AGENT = {
  'image.txt2img': 'image', 'image.genimage': 'image', 'image.aiwriter': 'image', 'image.dalle': 'image',
  'music.aimelody': 'music', 'music.text2music.create': 'music', 'video.create': 'video',
  'chat.aiwriterChat': null, 'chat.chatex': null, 'chat.askgpt5': null, 'chat.mistral': null,
  'chat.writer': 'chat', 'chat.summarize': 'chat',
  'html2image.direct': 'html2image', 'html2image.json': 'html2image', 'tts.default': 'tts',
  'code.compile.python': 'code', 'code.compile.js': 'code', 'code.compile.java': 'code',
  'code.compile.c': 'code', 'code.compile.cpp': 'code', 'code.compile.csharp': 'code',
  'code.convert.python': 'code', 'code.convert.js': 'code', 'code.convert.java': 'code',
  'code.convert.cpp': 'code', 'code.convert.php': 'code',
  'mcp.call': 'mcp'
};
const SHARED_CHAT_ENDPOINT_AGENTS = ['image2html', 'web', 'chat'];

function buildSystemPrompt(mcpTools) {
  var base =
    'You are the Master Agent router for Canton Node, a multi-tool generative hub. ' +
    'You do NOT answer the user yourself — you only choose which tool to run. ' +
    'Reply with ONLY a JSON object (no markdown, no prose):\n' +
    '{"agent_id":"image|music|video|image2html|html2image|tts|code|web|chat|mcp",' +
    '"endpoint":"...","params":{...},"reasoning":"..."}\n' +
    'Tools:\n' +
    '- image → endpoint image.genimage, params {prompt}\n' +
    '- video → endpoint video.create, params {prompt}\n' +
    '- music → endpoint music.aimelody, params {prompt}\n' +
    '- tts → endpoint tts.default, params {text}\n' +
    '- code → endpoint code.compile.python, params {code}\n' +
    '- chat → endpoint chat.askgpt5 (general questions)\n' +
    '- web → endpoint chat.askgpt5 with web:true for current events\n' +
    '- mcp → endpoint mcp.call, params {serverId, tool, ...toolArgs} when an external MCP tool fits\n' +
    'If the user asks for an image, picture, logo, drawing → image.\n' +
    'If they ask for a video, clip, animation → video.\n' +
    'If they ask for a song or music → music.\n' +
    'Never claim you lack tools; always pick the best agent_id.';

  if (mcpTools && mcpTools.length) {
    base += '\n\nExternal MCP tools available (prefer agent_id "mcp" when the user clearly wants one of these):\n';
    mcpTools.slice(0, 30).forEach(function (t) {
      base += '- ' + t.qualified + ' | serverId=' + t.serverId + ' tool=' + t.name +
        ' | ' + (t.description || '') + '\n';
    });
    base += 'When choosing mcp, set endpoint to "mcp.call" and params to ' +
      '{ "serverId": "...", "tool": "exact_tool_name", ...any tool arguments }.';
  }
  return base;
}

function heuristicRoute(message, mcpTools) {
  var m = message.toLowerCase();
  if (/\b(video|clip|animation|footage|\.mp4|text.?to.?video|generate (a )?video)\b/.test(m))
    return { agent_id: 'video', endpoint: 'video.create', params: { prompt: message }, reasoning: 'Heuristic: video' };
  if (/\b(image|logo|picture|photo|draw|illustration|txt2img|text.?to.?image|generate (an? )?(img|image))\b/.test(m))
    return { agent_id: 'image', endpoint: 'image.genimage', params: { prompt: message }, reasoning: 'Heuristic: image' };
  if (/\b(music|song|melody|audio track|compose)\b/.test(m))
    return { agent_id: 'music', endpoint: 'music.aimelody', params: { prompt: message }, reasoning: 'Heuristic: music' };
  if (/\b(tts|speak|voice|read aloud|text.to.speech)\b/.test(m))
    return { agent_id: 'tts', endpoint: 'tts.default', params: { text: message }, reasoning: 'Heuristic: TTS' };
  if (/\b(html.?to.?image|screenshot html|render html)\b/.test(m))
    return { agent_id: 'html2image', endpoint: 'html2image.direct', params: { html: message }, reasoning: 'Heuristic: html2image' };
  if (/\b(image.?to.?html|html from image)\b/.test(m))
    return { agent_id: 'image2html', endpoint: 'chat.askgpt5', params: { prompt: message }, reasoning: 'Heuristic: image2html' };
  if (/\b(compile|convert code|translate (this )?code)\b/.test(m) && /```|function |def |const |class /.test(message))
    return { agent_id: 'code', endpoint: 'code.compile.python', params: { code: message }, reasoning: 'Heuristic: code' };
  if (/\b(search the web|look up|latest news|current events)\b/.test(m))
    return { agent_id: 'web', endpoint: 'chat.askgpt5', params: { prompt: message, web: true }, reasoning: 'Heuristic: web' };
  if (/\b(what can you do|your (tools|capabilities|features)|list (your )?tools|use (the )?tools|tools? you have|who are you|what are you)\b/.test(m))
    return { agent_id: 'chat', endpoint: 'chat.capabilities', params: { prompt: message }, reasoning: 'Heuristic: capabilities' };

  // Prefer MCP when user names CoinGecko / connected server or crypto price with MCP context
  if (mcpTools && mcpTools.length) {
    var wantsMcp =
      /\b(coingecko|mcp)\b/i.test(message) ||
      (/\b(price|market cap|token|crypto|bitcoin|btc|ethereum|eth)\b/i.test(message) &&
        mcpTools.some(function (t) { return /coingecko/i.test(t.serverName || t.qualified || ''); }));

    for (var i = 0; i < mcpTools.length; i++) {
      var t = mcpTools[i];
      if (t.qualified && m.indexOf(String(t.qualified).toLowerCase()) !== -1) {
        return {
          agent_id: 'mcp',
          endpoint: 'mcp.call',
          params: { serverId: t.serverId, tool: t.name },
          reasoning: 'Heuristic: explicit MCP tool ' + t.qualified
        };
      }
    }

    if (wantsMcp) {
      // CoinGecko exposes execute + search_docs — default to execute for price queries
      var pick = mcpTools.find(function (x) { return x.name === 'execute'; }) || mcpTools[0];
      return {
        agent_id: 'mcp',
        endpoint: 'mcp.call',
        params: { serverId: pick.serverId, tool: pick.name },
        reasoning: 'Heuristic: MCP for crypto/data query via ' + (pick.serverName || pick.qualified)
      };
    }
  }
  return null;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractRouteJson(raw) {
  if (!raw) return null;
  var s = String(raw).trim().replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(s); } catch (_) {}
  var start = s.indexOf('{');
  var end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

function isValidRoute(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (typeof parsed.agent_id !== 'string' || typeof parsed.endpoint !== 'string') return false;
  return true;
}

async function safeText(resp) {
  try { return await resp.text(); } catch (_) { return ''; }
}

function authHeaders(provider, apiKey) {
  var h = {
    'content-type': 'application/json',
    authorization: 'Bearer ' + apiKey
  };
  if (provider.id === 'openrouter') {
    h['http-referer'] = 'https://canton-node.vercel.app';
    h['x-title'] = 'Canton Node';
  }
  return h;
}

async function callChat(provider, modelCfg, messages, maxTokens) {
  var apiKey = process.env[provider.envKey];
  if (!apiKey) throw new Error(provider.envKey + ' not set');
  var body = {
    model: modelCfg.model,
    messages: messages,
    max_tokens: maxTokens || 400
  };
  if (provider.id === 'openrouter') body.response_format = { type: 'json_object' };
  var resp = await fetch(provider.url, {
    method: 'POST',
    headers: authHeaders(provider, apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000)
  });
  if (!resp.ok) {
    var detail = await safeText(resp);
    throw new Error('HTTP ' + resp.status + (detail ? ' — ' + detail.slice(0, 180) : ''));
  }
  var data = await resp.json();
  var msg = data && data.choices && data.choices[0] && data.choices[0].message;
  return (msg && typeof msg.content === 'string' ? msg.content.trim() : '') || null;
}

async function tryRouteWithProvider(provider, message, systemPrompt, errors) {
  if (!process.env[provider.envKey]) {
    errors.push(provider.label + ': ' + provider.envKey + ' not set');
    return null;
  }
  for (var mi = 0; mi < provider.models.length; mi++) {
    var m = provider.models[mi];
    try {
      var content = await callChat(provider, m, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ], 400);
      var parsed = extractRouteJson(content);
      if (isValidRoute(parsed)) return { route: parsed, modelUsed: m.label, providerId: provider.id };
      errors.push(m.label + ': invalid route');
    } catch (e) {
      errors.push(m.label + ': ' + e.message);
    }
  }
  return null;
}

function sanitizeParams(params) {
  var allowed = {
    prompt: 1, text: 1, code: 1, from: 1, voice: 1, size: 1, steps: 1, style: 1,
    image: 1, lyrics: 1, title: 1, html: 1, width: 1, height: 1, stdin: 1, web: 1, duration: 1,
    serverId: 1, tool: 1, name: 1, qualified: 1
  };
  var out = {};
  if (!params || typeof params !== 'object') return out;
  var keys = Object.keys(params);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = params[k];
    if (allowed[k] || k.indexOf('arg_') === 0 || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      if (v !== undefined && v !== null && v !== '') out[k] = v;
    }
  }
  return out;
}

function buildCapabilitiesText(mcpTools) {
  var text =
    'I am the **Canton Node Master Agent** — a router and orchestrator for this hub, not a text-only chatbot.\n\n' +
    'When you ask for media or code, I **route** the request to the right tool. Available tools:\n\n' +
    '| Tool | Example prompt | Daily quota |\n' +
    '|------|----------------|-------------|\n' +
    '| **Image** | Generate a sunset over mountains | 12/day |\n' +
    '| **Video** | Make a short video of waves on a beach | 4/day |\n' +
    '| **Music** | Compose a calm lo-fi beat | 8/day |\n' +
    '| **TTS** | Speak this text: Hello world | 50/day |\n' +
    '| **Code** | paste code and ask to compile/convert | 50/day |\n' +
    '| **Chat / Q&A** | any general question | Master routing 80/day |\n';

  if (mcpTools && mcpTools.length) {
    text += '\n**Connected MCP tools** (external):\n\n';
    mcpTools.slice(0, 20).forEach(function (t) {
      text += '- `' + t.qualified + '` — ' + (t.description || t.name) + ' _(via ' + t.serverName + ')_\n';
    });
    text += '\nAsk for an MCP tool by name, or describe the task; press **Execute MCP** on the route card.\n';
  } else {
    text += '\n_No MCP servers connected. Add them under Settings → MCP Servers._\n';
  }

  text +=
    '\n**How to use a tool:** describe what you want (e.g. draw a neon city skyline). ' +
    'I return a route card; for image/video/music press **Execute** (uses that tool quota).\n\n' +
    'I will not pretend I lack these tools. If something fails, use **Edit prompt** or **Regenerate**.';
  return text;
}

const TONE_MAP = {
  friendly: 'warm, approachable, and encouraging',
  professional: 'professional, clear, and businesslike',
  concise: 'brief and to the point — minimize filler',
  technical: 'precise and technical; prefer exact terms',
  playful: 'light, witty, and informal without being unhelpful'
};

function buildPersonaPrompt(prefs) {
  prefs = prefs || {};
  var name = String(prefs.displayName || '').trim();
  var toneKey = String(prefs.tone || 'friendly').toLowerCase();
  var tone = TONE_MAP[toneKey] || TONE_MAP.friendly;
  var s = 'Reply in a ' + tone + ' tone.';
  if (name) {
    s += ' The user prefers to be addressed as "' + name.replace(/["\\]/g, '') + '". Use their name naturally when greeting or when it fits; do not overuse it.';
  }
  return s;
}

function normalizeMcpTools(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 40).map(function (t) {
    if (!t || typeof t !== 'object') return null;
    return {
      qualified: String(t.qualified || '').slice(0, 120),
      serverId: String(t.serverId || '').slice(0, 64),
      serverName: String(t.serverName || '').slice(0, 80),
      name: String(t.name || '').slice(0, 80),
      description: String(t.description || '').slice(0, 200)
    };
  }).filter(function (t) { return t && t.serverId && t.name; });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed. Use POST.' });
      return;
    }

    if (!LLM_CHAIN.some(function (p) { return !!process.env[p.envKey]; })) {
      res.status(500).json({
        error: 'No router API keys configured. Set VINCI_API_KEY and/or OPENROUTER_API_KEY and/or HF_TOKEN.'
      });
      return;
    }

    var message;
    var history = [];
    var prefs = {};
    var mcpTools = [];
    try {
      var body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      message = String(body.message || '').trim();
      prefs = (body.prefs && typeof body.prefs === 'object') ? body.prefs : {};
      mcpTools = normalizeMcpTools(body.mcp_tools);
      if (Array.isArray(body.history)) {
        history = body.history
          .filter(function (m) {
            return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string';
          })
          .slice(-12)
          .map(function (m) {
            return { role: m.role, content: String(m.content).slice(0, 2000) };
          });
      }
    } catch (_) {
      res.status(400).json({ error: 'Invalid JSON body.' });
      return;
    }
    if (!message) {
      res.status(400).json({ error: 'Missing "message".' });
      return;
    }
    if (message.length > 4000) {
      res.status(400).json({ error: 'Message too long (max 4000 characters).' });
      return;
    }

    var systemPrompt = buildSystemPrompt(mcpTools);
    var routeErrors = [];
    var route = null;
    var modelUsed = null;
    var fallbackUsed = false;
    var providerId = null;

    route = heuristicRoute(message, mcpTools);
    if (route) {
      modelUsed = 'heuristic';
      providerId = 'heuristic';
    }

    if (!route) {
      for (var pi = 0; pi < LLM_CHAIN.length; pi++) {
        var provider = LLM_CHAIN[pi];
        var hit = await tryRouteWithProvider(provider, message, systemPrompt, routeErrors);
        if (hit) {
          route = hit.route;
          modelUsed = hit.modelUsed;
          providerId = hit.providerId;
          fallbackUsed = provider.id !== 'vinci';
          break;
        }
      }
    }

    if (!route) {
      res.status(502).json({
        error: 'All routers failed (heuristic + Vinci + OpenRouter + Hugging Face).',
        detail: routeErrors.join(' | ')
      });
      return;
    }

    var fallbackNote = null;
    if (providerId && providerId !== 'heuristic' && providerId !== 'vinci') {
      fallbackNote = 'Primary Vinci router skipped or failed — used ' + modelUsed + '.';
    }

    if (route.agent_id === 'mcp' || (typeof route.endpoint === 'string' && route.endpoint.indexOf('mcp') === 0)) {
      route.agent_id = 'mcp';
      route.endpoint = 'mcp.call';
      var p = route.params && typeof route.params === 'object' ? route.params : {};
      if ((!p.serverId || !p.tool) && p.qualified && mcpTools.length) {
        var match = mcpTools.find(function (t) { return t.qualified === p.qualified; });
        if (match) {
          p.serverId = match.serverId;
          p.tool = match.name;
        }
      }
      if ((!p.serverId || !p.tool) && p.tool && mcpTools.length) {
        var match2 = mcpTools.find(function (t) { return t.name === p.tool; });
        if (match2) p.serverId = match2.serverId;
      }
      route.params = p;
    }

    var owner = ENDPOINT_TO_AGENT[route.endpoint];
    var validForShared = owner === null && SHARED_CHAT_ENDPOINT_AGENTS.indexOf(route.agent_id) !== -1;
    if (owner !== undefined && owner !== route.agent_id && !validForShared && route.agent_id !== 'mcp') {
      fallbackNote = (fallbackNote ? fallbackNote + ' ' : '') +
        'Model paired "' + route.endpoint + '" with agent "' + route.agent_id + '".';
    }

    var routedParams = sanitizeParams(route.params);
    if ((route.agent_id === 'image' || route.agent_id === 'video') && !routedParams.prompt) {
      routedParams.prompt = message;
    }

    if (route.endpoint === 'chat.capabilities') {
      res.status(200).json({
        agent_id: 'chat',
        endpoint: 'chat.capabilities',
        params: { prompt: message },
        result: buildCapabilitiesText(mcpTools),
        source: 'master-capabilities',
        server_executed: true,
        reasoning: typeof route.reasoning === 'string' ? route.reasoning : 'Capabilities overview',
        fallback_note: fallbackNote,
        model_used: 'master-capabilities',
        fallback_used: false
      });
      return;
    }

    if (route.agent_id === 'chat' || route.agent_id === 'web') {
      var gen = await tryGenerateAnswer(message, history, prefs, mcpTools);
      res.status(200).json({
        agent_id: route.agent_id,
        endpoint: 'llm.generate',
        params: { prompt: message },
        result: gen.text,
        source: gen.text ? (gen.provider || 'llm') : 'error',
        server_executed: true,
        generation_attempts: gen.attempts,
        reasoning: typeof route.reasoning === 'string' ? route.reasoning : '',
        fallback_note: fallbackNote,
        model_used: gen.model || modelUsed,
        fallback_used: fallbackUsed
      });
      return;
    }

    if (route.agent_id === 'mcp') {
      res.status(200).json({
        agent_id: 'mcp',
        endpoint: 'mcp.call',
        params: routedParams,
        mcp_server_id: routedParams.serverId || null,
        mcp_tool: routedParams.tool || routedParams.name || null,
        reasoning: typeof route.reasoning === 'string' ? route.reasoning : 'MCP tool',
        fallback_note: fallbackNote,
        model_used: modelUsed,
        fallback_used: fallbackUsed
      });
      return;
    }

    res.status(200).json({
      agent_id: route.agent_id,
      endpoint: route.endpoint,
      params: routedParams,
      reasoning: typeof route.reasoning === 'string' ? route.reasoning : '',
      fallback_note: fallbackNote,
      model_used: modelUsed,
      fallback_used: fallbackUsed
    });
  } catch (err) {
    console.error('[master]', err);
    try {
      res.status(500).json({ error: 'Master router crashed', detail: String(err && err.message ? err.message : err).slice(0, 300) });
    } catch (_) {}
  }
};

async function tryGenerateAnswer(message, history, prefs, mcpTools) {
  var attempts = [];
  var prior = Array.isArray(history) ? history : [];
  var mcpHint = '';
  if (mcpTools && mcpTools.length) {
    mcpHint = ' Connected MCP tools: ' +
      mcpTools.slice(0, 15).map(function (t) { return t.qualified; }).join(', ') +
      '. Users can ask for these by name.';
  }
  for (var pi = 0; pi < LLM_CHAIN.length; pi++) {
    var provider = LLM_CHAIN[pi];
    var apiKey = process.env[provider.envKey];
    if (!apiKey) {
      attempts.push({ endpoint: provider.id, error: provider.envKey + ' not set' });
      continue;
    }
    for (var mi = 0; mi < provider.models.length; mi++) {
      var m = provider.models[mi];
      try {
        var messages = [
          {
            role: 'system',
            content: 'You are the Canton Node Master Agent — orchestrator for a multi-tool generative hub. ' +
            'You CAN route users to real tools: image, video, music, TTS, code generation, and MCP external tools. ' +
            'You are NOT a text-only chatbot. Never say you lack image, video, music, or media tools. ' +
            'If the user wants media, tell them to ask concretely (e.g. Generate an image of…). ' +
            'After routing, they may need to press Execute or Execute MCP. ' +
            'Daily quotas: Master routing 80, image 12, video 4, music 8, TTS 50, code 50. ' +
            mcpHint +
            ' Use prior turns when relevant. Answer clearly. ' +
            buildPersonaPrompt(prefs)
          }
        ].concat(prior).concat([{ role: 'user', content: message }]);
        var resp = await fetch(provider.url, {
          method: 'POST',
          headers: authHeaders(provider, apiKey),
          body: JSON.stringify({ model: m.model, messages: messages, max_tokens: 800 }),
          signal: AbortSignal.timeout(45000)
        });
        if (!resp.ok) {
          var detail = await safeText(resp);
          attempts.push({ endpoint: m.model, error: 'HTTP ' + resp.status + ' — ' + detail.slice(0, 120) });
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

module.exports.config = { maxDuration: 60 };
