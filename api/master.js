/* =========================================================================
 * api/master.js — Master Agent router (simplified)
 *
 * Priority: heuristic → Vinci → OpenRouter → HF
 * Chat/web: uses client-sent history[] (last 12 turns) for in-session memory.
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
  'code.convert.cpp': 'code', 'code.convert.php': 'code'
};
const SHARED_CHAT_ENDPOINT_AGENTS = ['image2html', 'web', 'chat'];

const SYSTEM_PROMPT =
  'You route requests for a multi-tool hub. Reply with ONLY a JSON object:\n' +
  '{"agent_id":"image|music|video|image2html|html2image|tts|code|web|chat",' +
  '"endpoint":"...","params":{...},"reasoning":"..."}\n' +
  'Endpoints: image.genimage, image.txt2img, image.dalle, video.create, music.aimelody, ' +
  'tts.default, chat.askgpt5, html2image.direct, code.compile.python, code.convert.python.\n' +
  'Image → image.genimage + {prompt}. Video → video.create + {prompt}. Chat → chat.askgpt5.';

function heuristicRoute(message) {
  const m = message.toLowerCase();
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
  return null;
}

function extractRouteJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(s); } catch (_) {}
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
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
  const h = {
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
  const apiKey = process.env[provider.envKey];
  if (!apiKey) throw new Error(provider.envKey + ' not set');
  const body = {
    model: modelCfg.model,
    messages: messages,
    max_tokens: maxTokens || 400
  };
  if (provider.id === 'openrouter') body.response_format = { type: 'json_object' };
  const resp = await fetch(provider.url, {
    method: 'POST',
    headers: authHeaders(provider, apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000)
  });
  if (!resp.ok) {
    const detail = await safeText(resp);
    throw new Error('HTTP ' + resp.status + (detail ? ' — ' + detail.slice(0, 180) : ''));
  }
  const data = await resp.json();
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  return (msg && typeof msg.content === 'string' ? msg.content.trim() : '') || null;
}

async function tryRouteWithProvider(provider, message, errors) {
  if (!process.env[provider.envKey]) {
    errors.push(provider.label + ': ' + provider.envKey + ' not set');
    return null;
  }
  for (const m of provider.models) {
    try {
      const content = await callChat(provider, m, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message }
      ], 400);
      const parsed = extractRouteJson(content);
      if (isValidRoute(parsed)) return { route: parsed, modelUsed: m.label, providerId: provider.id };
      errors.push(m.label + ': invalid route');
    } catch (e) {
      errors.push(m.label + ': ' + e.message);
    }
  }
  return null;
}

function sanitizeParams(params) {
  const allowed = new Set([
    'prompt', 'text', 'code', 'from', 'voice', 'size', 'steps', 'style',
    'image', 'lyrics', 'title', 'html', 'width', 'height', 'stdin', 'web', 'duration'
  ]);
  const out = {};
  if (!params || typeof params !== 'object') return out;
  for (const [k, v] of Object.entries(params)) {
    if (allowed.has(k) && v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}

module.exports = async function handler(req, res) {
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

  let message;
  let history = [];
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    message = String(body.message || '').trim();
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

  const routeErrors = [];
  let route = null;
  let modelUsed = null;
  let fallbackUsed = false;
  let providerId = null;

  route = heuristicRoute(message);
  if (route) {
    modelUsed = 'heuristic';
    providerId = 'heuristic';
  }

  if (!route) {
    for (const provider of LLM_CHAIN) {
      const hit = await tryRouteWithProvider(provider, message, routeErrors);
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

  let fallbackNote = null;
  if (providerId && providerId !== 'heuristic' && providerId !== 'vinci') {
    fallbackNote = 'Primary Vinci router skipped or failed — used ' + modelUsed + '.';
  }

  const owner = ENDPOINT_TO_AGENT[route.endpoint];
  const validForShared = owner === null && SHARED_CHAT_ENDPOINT_AGENTS.includes(route.agent_id);
  if (owner !== undefined && owner !== route.agent_id && !validForShared) {
    fallbackNote = (fallbackNote ? fallbackNote + ' ' : '') +
      'Model paired "' + route.endpoint + '" with agent "' + route.agent_id + '".';
  }

  const routedParams = sanitizeParams(route.params);
  if ((route.agent_id === 'image' || route.agent_id === 'video') && !routedParams.prompt) {
    routedParams.prompt = message;
  }

  if (route.agent_id === 'chat' || route.agent_id === 'web') {
    const gen = await tryGenerateAnswer(message, history);
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

  res.status(200).json({
    agent_id: route.agent_id,
    endpoint: route.endpoint,
    params: routedParams,
    reasoning: typeof route.reasoning === 'string' ? route.reasoning : '',
    fallback_note: fallbackNote,
    model_used: modelUsed,
    fallback_used: fallbackUsed
  });
};

async function tryGenerateAnswer(message, history) {
  const attempts = [];
  const prior = Array.isArray(history) ? history : [];
  for (const provider of LLM_CHAIN) {
    const apiKey = process.env[provider.envKey];
    if (!apiKey) {
      attempts.push({ endpoint: provider.id, error: provider.envKey + ' not set' });
      continue;
    }
    for (const m of provider.models) {
      try {
        const messages = [
          {
            role: 'system',
            content: 'You are the Canton Node Master Agent assistant. Use prior turns in this conversation when relevant. Answer clearly and concisely.'
          }
        ].concat(prior).concat([{ role: 'user', content: message }]);
        const resp = await fetch(provider.url, {
          method: 'POST',
          headers: authHeaders(provider, apiKey),
          body: JSON.stringify({ model: m.model, messages: messages, max_tokens: 800 }),
          signal: AbortSignal.timeout(45000)
        });
        if (!resp.ok) {
          const detail = await safeText(resp);
          attempts.push({ endpoint: m.model, error: 'HTTP ' + resp.status + ' — ' + detail.slice(0, 120) });
          continue;
        }
        const data = await resp.json();
        const msg = data && data.choices && data.choices[0] && data.choices[0].message;
        const text = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
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
