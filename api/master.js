/* =========================================================================
 * api/master.js — Master Agent orchestrator (step 3, OpenRouter rework)
 *
 * PIVOT: Prexzy's own chat endpoints (chatex/askgpt5/mistral) turned out too
 * unreliable to be the routing brain — occasional downtime plus a param-name
 * mismatch caught via manual curl testing (chatex wants `text`, not `prompt`;
 * see ENDPOINT_DOCS below). Routing now runs on OpenRouter's free-tier
 * models via OPENROUTER_API_KEY. This key stays server-side — never sent to
 * the browser — same reasoning as the old Anthropic key.
 *
 * Model chain, most → least reliable for structured tool-calling:
 *   1. openrouter/free   — "Free Models Router": auto-picks a free model AND
 *      specifically filters for tool-calling support, so it's a safe primary.
 *   2. openai/gpt-oss-20b:free — confirmed native function-calling support.
 *   3. google/gemma-4-31b-it:free — tool-calling support unconfirmed for this
 *      model, so we don't force tool_choice on it; we still ask for the same
 *      JSON shape in plain text and extract it defensively.
 * We try each in order and use the first one that returns a usable routing
 * decision, so a single flaky/rate-limited free model never takes the whole
 * Master Agent down.
 *
 * Free-tier cap: 50 req/day at 20 req/min per OpenRouter account until you've
 * ever bought $10+ in credits (then 1,000/day, same 20 rpm). All three models
 * in the chain share that same account-wide cap — they don't stack.
 *
 * Contract with the browser is unchanged: takes a natural-language request,
 * returns { agent_id, endpoint, params, reasoning, fallback_note, model_used,
 * fallback_used }. The browser executes the actual Prexzy call itself via
 * PrexzyAPI.call() — this endpoint never talks to Prexzy at all now.
 *
 * NOTE ON DUPLICATION: ENDPOINT_DOCS mirrors the endpoint catalog in
 * js/api.js (path/params). api.js is written for the browser and can't be
 * required directly from this Node function without a bundler, so keep the
 * two in sync by hand. Worth extracting into a shared endpoints.json once
 * the catalog grows past this size.
 * ========================================================================= */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/* -------------------------------------------------------------------------
 * Router model chain. `useTools: false` means don't force tool_choice on it
 * (Gemma's tool-calling support on OpenRouter isn't confirmed) — instead
 * rely on the plain-JSON instruction in SYSTEM_PROMPT and parse defensively.
 * ------------------------------------------------------------------------- */
const ROUTER_MODELS = [
  { model: 'openrouter/free',          label: 'Free Models Router', useTools: true  },
  { model: 'openai/gpt-oss-20b:free',  label: 'GPT-OSS 20B',        useTools: true  },
  { model: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B',      useTools: false }
];

// Mirrors tools.json ids, kept here so we can validate the model's pick
// server-side without re-parsing tools.json at request time.
const AGENT_IDS = [
  'image', 'music', 'video', 'image2html',
  'html2image', 'tts', 'code', 'web', 'chat'
];

// endpoint key -> agent_id, for validating the model didn't cross-wire them.
const ENDPOINT_TO_AGENT = {
  'image.txt2img': 'image', 'image.genimage': 'image', 'image.aiwriter': 'image', 'image.dalle': 'image',
  'music.aimelody': 'music', 'music.text2music.create': 'music',
  'video.create': 'video',
  'chat.chatex': null,  // shared by web / chat — validated by agent_id context instead
  'chat.askgpt5': null, // shared by image2html / web / chat
  'chat.mistral': null,
  'chat.writer': 'chat', 'chat.summarize': 'chat',
  'html2image.direct': 'html2image', 'html2image.json': 'html2image',
  'tts.default': 'tts',
  'code.compile.python': 'code', 'code.compile.js': 'code', 'code.compile.java': 'code',
  'code.compile.c': 'code', 'code.compile.cpp': 'code', 'code.compile.csharp': 'code',
  'code.convert.python': 'code', 'code.convert.js': 'code', 'code.convert.java': 'code',
  'code.convert.cpp': 'code', 'code.convert.php': 'code'
};
// chat.chatex / chat.askgpt5 / chat.mistral are valid for these agents specifically.
const SHARED_CHAT_ENDPOINT_AGENTS = ['image2html', 'web', 'chat'];

// NOTE: chat.chatex takes {text}, NOT {prompt} — confirmed via curl:
// askgpt5/mistral return 400 "Parameter \"prompt\" is required" when sent q=,
// chatex returns 400 "Text parameter is required". Don't "fix" this back to
// {prompt} without re-testing against the live API first.
const ENDPOINT_DOCS = `
image        image.txt2img        {prompt}
image        image.genimage       {prompt, size?, steps?}
image        image.aiwriter       {prompt, size?}
image        image.dalle          {prompt}
music        music.aimelody       {prompt}
music        music.text2music.create  {lyrics, title?, style?}   -- async, returns task_id, not final audio
video        video.create         {prompt, image?, style?}       -- async, returns task_id, not final video
image2html   chat.askgpt5         {prompt}   -- describe the layout/image in words; no real vision input wired yet
html2image   html2image.direct    {html, width?, height?}
html2image   html2image.json      {html, width?, height?}
tts          tts.default          {text, voice?}
code         code.compile.python|js|java|c|cpp|csharp   {code, stdin?}
code         code.convert.python|js|java|cpp|php        {code, from?}
web          chat.chatex          {text, web:true}
web          chat.askgpt5         {prompt, web:true}
web          chat.mistral         {prompt, web:true}
chat         chat.chatex          {text}
chat         chat.askgpt5         {prompt}
chat         chat.mistral         {prompt}
chat         chat.writer          {prompt}
chat         chat.summarize       {text}
`.trim();

const ROUTE_SCHEMA = {
  type: 'object',
  properties: {
    agent_id: { type: 'string', enum: AGENT_IDS },
    endpoint: { type: 'string', description: 'One endpoint key from the catalog, e.g. "image.txt2img".' },
    params: {
      type: 'object',
      description: 'Only the fields the chosen endpoint needs.',
      properties: {
        prompt: { type: 'string' }, text: { type: 'string' }, code: { type: 'string' },
        from: { type: 'string' }, voice: { type: 'string' }, size: { type: 'string' },
        steps: { type: 'string' }, style: { type: 'string' }, image: { type: 'string' },
        lyrics: { type: 'string' }, title: { type: 'string' }, html: { type: 'string' },
        width: { type: 'string' }, height: { type: 'string' }, stdin: { type: 'string' },
        web: { type: 'boolean' }
      },
      additionalProperties: false
    },
    reasoning: { type: 'string' }
  },
  required: ['agent_id', 'endpoint', 'params', 'reasoning']
};

const SYSTEM_PROMPT = `You are the routing layer for a multi-tool API platform. Given a user's request, pick exactly one agent_id and one endpoint from the catalog below, and extract only the params that endpoint needs from the user's message.

Catalog (agent_id, endpoint, required params — "?" means optional):
${ENDPOINT_DOCS}

Rules:
- If you can call tools, call the route_request tool — nothing else.
- If you cannot call tools, respond with ONLY a single JSON object on one line, no markdown fences, no commentary: {"agent_id":"...","endpoint":"...","params":{...},"reasoning":"one short sentence"}
- "agent_id" must be one of: ${AGENT_IDS.join(', ')}.
- "endpoint" must be one endpoint key from the catalog, e.g. "image.txt2img".
- Do not guess params that aren't implied by the message — omit optional ones you're not confident about.
- For code.compile.* / code.convert.* endpoints, "code" must be the actual code from the user's message.
- Keep "reasoning" to one short sentence.`;

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
  // Cheap guard against runaway prompts from a pasted essay / huge code file.
  if (message.length > 4000) {
    res.status(400).json({ error: 'Message too long (max 4000 characters).' });
    return;
  }

  // Walk the model chain until one returns a usable routing decision.
  let route = null, modelUsed = null, fallbackUsed = false;
  const errors = [];
  for (const m of ROUTER_MODELS) {
    try {
      const parsed = await callOpenRouter(apiKey, m, message);
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
      error: 'All OpenRouter free models failed to produce a routing decision.',
      detail: errors.join(' | ')
    });
    return;
  }

  let fallbackNote = fallbackUsed
    ? `Primary router (Free Models Router) was unavailable — routed with ${modelUsed} instead.`
    : null;

  // Validate endpoint belongs to that agent (shared chat.* endpoints get special-cased).
  const owner = ENDPOINT_TO_AGENT[route.endpoint];
  const validForSharedAgent = owner === null && SHARED_CHAT_ENDPOINT_AGENTS.includes(route.agent_id);
  if (owner !== route.agent_id && !validForSharedAgent) {
    fallbackNote = (fallbackNote ? fallbackNote + ' ' : '') +
      `Model paired "${route.endpoint}" with agent "${route.agent_id}", which didn't match — check the result carefully.`;
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

/* -------------------------------------------------------------------------
 * Call one OpenRouter model with the routing prompt. Tries native tool
 * calling first (when useTools is set); falls back to parsing the message
 * content as JSON either way, since a model can ignore tool_choice.
 * ------------------------------------------------------------------------- */
async function callOpenRouter(apiKey, modelCfg, message) {
  const body = {
    model: modelCfg.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: message }
    ],
    max_tokens: 500
  };

  if (modelCfg.useTools) {
    body.tools = [{
      type: 'function',
      function: {
        name: 'route_request',
        description: 'Route the user request to the correct agent + endpoint with extracted params.',
        parameters: ROUTE_SCHEMA
      }
    }];
    body.tool_choice = { type: 'function', function: { name: 'route_request' } };
  }

  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + apiKey,
      // Optional but recommended by OpenRouter for leaderboard attribution —
      // harmless to include, safe to remove if you don't want it listed.
      'http-referer': 'https://canton-node.vercel.app',
      'x-title': 'Prexzy Multi-Tool Platform'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const detail = await safeText(resp);
    throw new Error(`HTTP ${resp.status}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
  }

  const data = await resp.json();
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  if (!msg) throw new Error('No message in response');

  // Path 1: proper tool call.
  const toolCall = (msg.tool_calls || []).find(t => t && t.function && t.function.name === 'route_request');
  if (toolCall) {
    try { return JSON.parse(toolCall.function.arguments); }
    catch (e) { /* fall through to content parsing */ }
  }

  // Path 2: model answered in plain text — extract JSON defensively.
  return extractRouteJson(msg.content);
}

function extractRouteJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/```(?:json)?/gi, '').trim();

  try { return JSON.parse(s); } catch (_) { /* fall through */ }

  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (_) { /* give up */ }
  }
  return null;
}

async function safeText(resp) {
  try { return await resp.text(); } catch (_) { return ''; }
}

// Only forward fields the routed endpoint actually understands.
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
