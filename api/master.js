/* api/master.js — Master Agent orchestrator (OpenRouter-aware) */

const PREXZY_BASE = 'https://prexzyapis.com';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const ROUTER_MODELS = [
  // Prexzy first (no key)
  { provider: 'prexzy', key: 'chatex',  label: 'GPT-5.4', path: '/ai/chatex' },
  { provider: 'prexzy', key: 'askgpt5', label: 'GPT-5',   path: '/ai/askgpt5' },
  { provider: 'prexzy', key: 'mistral', label: 'Mistral', path: '/ai/mistral' },
  // Free OpenRouter fallbacks (uses OPENROUTER_API_KEY)
  { provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra (free)' },
  { provider: 'openrouter', model: 'poolside/laguna-s-2.1:free',            label: 'Laguna S 2.1 (free)' },
  { provider: 'openrouter', model: 'openrouter/free',                       label: 'OpenRouter Free Router' },
];

const AGENT_IDS = [
  'image', 'music', 'video', 'image2html',
  'html2image', 'tts', 'code', 'web', 'chat'
];

const ENDPOINT_TO_AGENT = {
  'image.txt2img': 'image', 'image.genimage': 'image', 'image.aiwriter': 'image', 'image.dalle': 'image',
  'music.aimelody': 'music', 'music.text2music.create': 'music',
  'video.create': 'video',
  'chat.chatex': null, 'chat.askgpt5': null, 'chat.mistral': null,
  'chat.writer': 'chat', 'chat.summarize': 'chat',
  'html2image.direct': 'html2image', 'html2image.json': 'html2image',
  'tts.default': 'tts',
  'code.compile.python': 'code', 'code.compile.js': 'code', 'code.compile.java': 'code',
  'code.compile.c': 'code', 'code.compile.cpp': 'code', 'code.compile.csharp': 'code',
  'code.convert.python': 'code', 'code.convert.js': 'code', 'code.convert.java': 'code',
  'code.convert.cpp': 'code', 'code.convert.php': 'code'
};

const SHARED_CHAT_ENDPOINT_AGENTS = ['image2html', 'web', 'chat'];

const ENDPOINT_DOCS = `
image        image.txt2img        {prompt}
image        image.genimage       {prompt, size?, steps?}
image        image.aiwriter       {prompt, size?}
image        image.dalle          {prompt}
music        music.aimelody       {prompt}
music        music.text2music.create  {lyrics, title?, style?}
video        video.create         {prompt, image?, style?}
image2html   chat.askgpt5         {prompt}
html2image   html2image.direct    {html, width?, height?}
html2image   html2image.json      {html, width?, height?}
tts          tts.default          {text, voice?}
code         code.compile.python|js|java|c|cpp|csharp   {code, stdin?}
code         code.convert.python|js|java|cpp|php        {code, from?}
web          chat.chatex          {prompt, web:true}
web          chat.askgpt5         {prompt, web:true}
web          chat.mistral         {prompt, web:true}
chat         chat.chatex          {prompt}
chat         chat.askgpt5         {prompt}
chat         chat.mistral         {prompt}
chat         chat.writer          {prompt}
chat         chat.summarize       {text}
`.trim();

const SYSTEM_PROMPT = `You are the routing layer for a multi-tool API platform. Given a user's request, pick exactly one agent_id and one endpoint from the catalog below, and extract only the params that endpoint needs from the user's message.

Catalog (agent_id, endpoint, required params — "?" means optional):
${ENDPOINT_DOCS}

Rules:
- Respond with ONLY a single JSON object on one line, no markdown fences, no commentary.
- JSON shape: {"agent_id":"...","endpoint":"...","params":{...},"reasoning":"one short sentence"}
- "agent_id" must be one of: ${AGENT_IDS.join(', ')}.
- "endpoint" must be one endpoint key from the catalog.
- Do not guess params that aren't implied by the message.
- For code.compile.* / code.convert.* endpoints, "code" must be the actual code from the user's message.
- Keep "reasoning" to one short sentence.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
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

  const prompt = SYSTEM_PROMPT + '\n\nUser request: ' + message;

  let route = null, modelUsed = null, fallbackUsed = false;
  const errors = [];

  for (const m of ROUTER_MODELS) {
    try {
      let raw;
      if (m.provider === 'prexzy') {
        raw = await callPrexzyChat(m, prompt);
      } else {
        raw = await callOpenRouter(m.model, prompt);
      }
      const parsed = extractRouteJson(raw);
      if (parsed && AGENT_IDS.includes(parsed.agent_id) && ENDPOINT_TO_AGENT[parsed.endpoint] !== undefined) {
        route = parsed;
        modelUsed = m.label;
        fallbackUsed = m !== ROUTER_MODELS[0];
        break;
      }
      errors.push(m.label + ': unparseable or invalid routing JSON');
    } catch (e) {
      errors.push(m.label + ': ' + e.message);
    }
  }

  if (!route) {
    res.status(502).json({
      error: 'All router models failed to produce a routing decision.',
      detail: errors.join(' | ')
    });
    return;
  }

  let fallbackNote = fallbackUsed
    ? `Primary router was unavailable — routed with ${modelUsed} instead.`
    : null;

  const owner = ENDPOINT_TO_AGENT[route.endpoint];
  const validForSharedAgent = owner === null && SHARED_CHAT_ENDPOINT_AGENTS.includes(route.agent_id);
  if (owner !== route.agent_id && !validForSharedAgent) {
    fallbackNote = (fallbackNote ? fallbackNote + ' ' : '') +
      `Model paired "\( {route.endpoint}" with agent " \){route.agent_id}" — check carefully.`;
  }

  res.status(200).json({
    agent_id: route.agent_id,
    endpoint: route.endpoint,
    params: sanitizeParams(route.params),
    reasoning: typeof route.reasoning === 'string' ? route.reasoning : '',
    fallback_note: fallbackNote,
    model_used: modelUsed,
    fallback_used: fallbackUsed
  });
};

async function callPrexzyChat(model, prompt) {
  const url = PREXZY_BASE + model.path + '?q=' + encodeURIComponent(prompt);
  const resp = await fetch(url, { method: 'GET' });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);

  const ctype = (resp.headers.get('content-type') || '').toLowerCase();
  let data = null, text = '';
  if (ctype.includes('application/json')) {
    data = await resp.json();
  } else {
    text = await resp.text();
    try { data = JSON.parse(text); } catch (_) {}
  }

  if (data && typeof data === 'object') {
    for (const k of ['result', 'response', 'answer', 'message', 'text', 'data']) {
      const v = data[k];
      if (typeof v === 'string' && v.trim()) return v;
      if (v && typeof v === 'object') {
        for (const kk of ['result', 'response', 'answer', 'text']) {
          if (typeof v[kk] === 'string' && v[kk].trim()) return v[kk];
        }
      }
    }
    return JSON.stringify(data);
  }
  return text;
}

async function callOpenRouter(model, prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set');

  const resp = await fetch(OPENROUTER_BASE + '/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://canton-node.local',
      'X-Title': 'Canton Node Master Router'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a precise JSON-only routing engine. Output only the required JSON object.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 400
    })
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error('OpenRouter HTTP ' + resp.status + ' ' + errText.slice(0, 120));
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty OpenRouter response');
  return content;
}

function extractRouteJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/```(?:json)?/gi, '').trim();

  try { return JSON.parse(s); } catch (_) {}

  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

const ALLOWED_PARAM_KEYS = new Set([
  'prompt', 'text', 'code', 'from', 'voice', 'size', 'steps', 'style',
  'image', 'lyrics', 'title', 'html', 'width', 'height', 'stdin', 'web'
]);
function sanitizeParams(params) {
  const out = {};
  if (!params || typeof params !== 'object') return out;
  for (const [k, v] of Object.entries(params)) {
    if (ALLOWED_PARAM_KEYS.has(k) && v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
      }
