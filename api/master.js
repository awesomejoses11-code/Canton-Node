/* api/master.js — Master Agent with heuristic + OpenRouter + HF fallback */
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const ROUTER_MODELS = [
  { model: 'openrouter/free', label: 'Free Models Router' },
  { model: 'openai/gpt-oss-20b:free', label: 'GPT-OSS 20B' },
  { model: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B' }
];
const HF_ROUTER_MODELS = [
  { model: 'Qwen/Qwen2.5-7B-Instruct', label: 'HF Qwen2.5 7B' },
  { model: 'meta-llama/Meta-Llama-3.1-8B-Instruct', label: 'HF Llama 3.1 8B' }
];

const AGENT_IDS = ['image','music','video','image2html','html2image','tts','code','web','chat'];
const ENDPOINT_TO_AGENT = {
  'image.txt2img':'image','image.genimage':'image','image.aiwriter':'image','image.dalle':'image',
  'music.aimelody':'music','music.text2music.create':'music','video.create':'video',
  'chat.aiwriterChat':null,'chat.chatex':null,'chat.askgpt5':null,'chat.mistral':null,
  'chat.writer':'chat','chat.summarize':'chat',
  'html2image.direct':'html2image','html2image.json':'html2image','tts.default':'tts',
  'code.compile.python':'code','code.compile.js':'code','code.compile.java':'code',
  'code.compile.c':'code','code.compile.cpp':'code','code.compile.csharp':'code',
  'code.convert.python':'code','code.convert.js':'code','code.convert.java':'code',
  'code.convert.cpp':'code','code.convert.php':'code'
};
const SHARED_CHAT_ENDPOINT_AGENTS = ['image2html','web','chat'];

function heuristicRoute(message) {
  const m = message.toLowerCase();
  if (/\b(video|clip|animation|footage|mp4)\b/.test(m))
    return { agent_id:'video', endpoint:'video.create', params:{ prompt: message }, reasoning:'Heuristic: video keywords' };
  if (/\b(image|logo|picture|photo|draw|illustration|generate an? (img|image)|txt2img)\b/.test(m))
    return { agent_id:'image', endpoint:'image.genimage', params:{ prompt: message }, reasoning:'Heuristic: image keywords' };
  if (/\b(music|song|melody|audio track)\b/.test(m))
    return { agent_id:'music', endpoint:'music.aimelody', params:{ prompt: message }, reasoning:'Heuristic: music keywords' };
  if (/\b(tts|speak|voice|read aloud|text.to.speech)\b/.test(m))
    return { agent_id:'tts', endpoint:'tts.default', params:{ text: message }, reasoning:'Heuristic: TTS keywords' };
  if (/\b(html.?to.?image|screenshot html|render html)\b/.test(m))
    return { agent_id:'html2image', endpoint:'html2image.direct', params:{ html: message }, reasoning:'Heuristic: html2image' };
  if (/\b(image.?to.?html|html from image)\b/.test(m))
    return { agent_id:'image2html', endpoint:'chat.askgpt5', params:{ prompt: message }, reasoning:'Heuristic: image2html' };
  if (/\b(compile|convert code|translate (this )?code)\b/.test(m) && /```|function |def |const |class /.test(message))
    return { agent_id:'code', endpoint:'code.compile.python', params:{ code: message }, reasoning:'Heuristic: code' };
  if (/\b(search the web|look up|latest news|current events)\b/.test(m))
    return { agent_id:'web', endpoint:'chat.askgpt5', params:{ prompt: message, web:true }, reasoning:'Heuristic: web' };
  return null;
}

function extractRouteJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(s); } catch (_) {}
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

async function safeText(resp) {
  try { return await resp.text(); } catch (_) { return ''; }
}

const SYSTEM_PROMPT = `You route requests for a multi-tool API. Reply with ONLY JSON:
{"agent_id":"image|music|video|image2html|html2image|tts|code|web|chat","endpoint":"...","params":{...},"reasoning":"..."}
Endpoints: image.genimage|image.txt2img|image.dalle|video.create|music.aimelody|tts.default|chat.askgpt5|chat.chatex|html2image.direct|code.compile.python|code.convert.python
For image use image.genimage with {prompt}. For video use video.create with {prompt}.`;

async function callOpenRouterRoute(apiKey, modelCfg, message) {
  const body = {
    model: modelCfg.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: message }
    ],
    max_tokens: 400,
    response_format: { type: 'json_object' }
  };
  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + apiKey,
      'http-referer': 'https://canton-node.vercel.app',
      'x-title': 'Canton Node'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const detail = await safeText(resp);
    throw new Error('HTTP ' + resp.status + (detail ? ' — ' + detail.slice(0, 160) : ''));
  }
  const data = await resp.json();
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  const extracted = extractRouteJson(msg && msg.content);
  if (extracted) return extracted;
  throw new Error('no parseable JSON — raw: ' + String(msg && msg.content || '').slice(0, 120));
}

async function callHFRoute(hfToken, modelCfg, message) {
  const resp = await fetch('https://router.huggingface.co/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + hfToken
    },
    body: JSON.stringify({
      model: modelCfg.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message }
      ],
      max_tokens: 400,
      temperature: 0.1
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (!resp.ok) {
    const detail = await safeText(resp);
    throw new Error('HTTP ' + resp.status + (detail ? ' — ' + detail.slice(0, 160) : ''));
  }
  const data = await resp.json();
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  const extracted = extractRouteJson(msg && msg.content);
  if (extracted) return extracted;
  throw new Error('no parseable JSON — raw: ' + String(msg && msg.content || '').slice(0, 120));
}

async function callOpenRouterGenerate(apiKey, modelCfg, message) {
  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + apiKey,
      'http-referer': 'https://canton-node.vercel.app',
      'x-title': 'Canton Node'
    },
    body: JSON.stringify({
      model: modelCfg.model,
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Answer concisely.' },
        { role: 'user', content: message }
      ],
      max_tokens: 800
    })
  });
  if (!resp.ok) {
    const detail = await safeText(resp);
    throw new Error('HTTP ' + resp.status + (detail ? ' — ' + detail.slice(0, 160) : ''));
  }
  const data = await resp.json();
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  const text = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
  return text || null;
}

function sanitizeParams(params) {
  const allowed = new Set(['prompt','text','code','from','voice','size','steps','style','image','lyrics','title','html','width','height','stdin','web']);
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
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'OPENROUTER_API_KEY is not set on the server.' });
    return;
  }

  let message;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    message = String(body.message || '').trim();
  } catch (e) {
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

  let route = null, modelUsed = null, fallbackUsed = false;
  const routeErrors = [];

  // 0) Fast heuristic — avoids OpenRouter rate limits for common intents
  route = heuristicRoute(message);
  if (route) {
    modelUsed = 'Heuristic';
  }

  // 1) OpenRouter free models
  if (!route) {
    for (const m of ROUTER_MODELS) {
      try {
        const parsed = await callOpenRouterRoute(apiKey, m, message);
        if (parsed && AGENT_IDS.includes(parsed.agent_id) && ENDPOINT_TO_AGENT[parsed.endpoint] !== undefined) {
          route = parsed;
          modelUsed = m.label;
          fallbackUsed = m !== ROUTER_MODELS[0];
          break;
        }
        routeErrors.push(m.label + ': invalid route');
      } catch (e) {
        routeErrors.push(m.label + ': ' + e.message);
      }
    }
  }

  // 2) Hugging Face contingency
  if (!route) {
    const hfToken = process.env.HF_TOKEN;
    if (hfToken) {
      for (const m of HF_ROUTER_MODELS) {
        try {
          const parsed = await callHFRoute(hfToken, m, message);
          if (parsed && AGENT_IDS.includes(parsed.agent_id) && ENDPOINT_TO_AGENT[parsed.endpoint] !== undefined) {
            route = parsed;
            modelUsed = m.label;
            fallbackUsed = true;
            break;
          }
          routeErrors.push(m.label + ': invalid route');
        } catch (e) {
          routeErrors.push(m.label + ': ' + e.message);
        }
      }
    } else {
      routeErrors.push('HF: HF_TOKEN not set');
    }
  }

  if (!route) {
    res.status(502).json({
      error: 'All routers failed (heuristic + OpenRouter free + Hugging Face).',
      detail: routeErrors.join(' | ')
    });
    return;
  }

  let fallbackNote = fallbackUsed
    ? ('Primary router unavailable — used ' + modelUsed + ' instead.')
    : null;

  const owner = ENDPOINT_TO_AGENT[route.endpoint];
  const validForShared = owner === null && SHARED_CHAT_ENDPOINT_AGENTS.includes(route.agent_id);
  if (owner !== route.agent_id && !validForShared) {
    fallbackNote = (fallbackNote ? fallbackNote + ' ' : '') +
      'Model paired "' + route.endpoint + '" with agent "' + route.agent_id + '".';
  }

  const routedParams = sanitizeParams(route.params);
  if ((route.agent_id === 'image' || route.agent_id === 'video') && !routedParams.prompt) {
    routedParams.prompt = message;
  }

  // chat / web — server-executed via OpenRouter
  if (route.agent_id === 'chat' || route.agent_id === 'web') {
    let text = null, genModel = null, attempts = [];
    for (const m of ROUTER_MODELS) {
      try {
        text = await callOpenRouterGenerate(apiKey, m, message);
        if (text) { genModel = m.label; break; }
        attempts.push({ endpoint: m.model, error: 'empty' });
      } catch (e) {
        attempts.push({ endpoint: m.model, error: e.message });
      }
    }
    res.status(200).json({
      agent_id: route.agent_id,
      endpoint: 'openrouter.generate',
      params: { prompt: message },
      result: text,
      source: text ? 'openrouter' : 'error',
      server_executed: true,
      generation_attempts: attempts,
      reasoning: typeof route.reasoning === 'string' ? route.reasoning : '',
      fallback_note: fallbackNote,
      model_used: genModel || modelUsed,
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

module.exports.config = { maxDuration: 60 };
