/* =========================================================================
 * api/master.js — Master Agent orchestrator (step 3, reworked)
 *
 * REWORK: the Anthropic keys were emptied, so the router no longer calls
 * Claude at all. Routing now runs on the most capable model available on
 * Prexzy — GPT-5.4 via `/ai/chatex` — with automatic fallback to GPT-5
 * (`/ai/askgpt5`) and then Mistral (`/ai/mistral`) if the primary is down.
 * No API key is required for any of these, so there are no secrets in this
 * function anymore (it stays server-side to avoid CORS surprises and to
 * keep the routing prompt/catalog out of the client bundle).
 *
 * Contract with the browser is unchanged: takes a natural-language request,
 * returns { agent_id, endpoint, params, reasoning }. The browser then
 * executes the actual Prexzy call itself via PrexzyAPI.call(), same as
 * every other path — this endpoint never talks to Prexzy for anything
 * other than the routing LLM call.
 *
 * NOTE ON DUPLICATION: ENDPOINT_DOCS below mirrors the endpoint catalog in
 * js/api.js (path/params), because api.js is written for the browser
 * (`window` global, fetch-building closures) and can't be required directly
 * from a Node serverless function without a bundler. If you add/change an
 * endpoint in api.js, update ENDPOINT_DOCS to match. Worth extracting into
 * a shared endpoints.json once the catalog grows past this size.
 * ========================================================================= */

const PREXZY_BASE = 'https://prexzyapis.com';

/* -------------------------------------------------------------------------
 * Router model chain, most → least capable. We try each in order and use
 * the first one that answers with a parseable routing decision, so a dead
 * or flaky upstream model never takes the Master Agent down.
 * ------------------------------------------------------------------------- */
const ROUTER_MODELS = [
  { key: 'chatex',   label: 'GPT-5.4', path: '/ai/chatex'   }, // primary — most capable on Prexzy
  { key: 'askgpt5',  label: 'GPT-5',   path: '/ai/askgpt5'  }, // fallback 1
  { key: 'mistral',  label: 'Mistral', path: '/ai/mistral'  }  // fallback 2
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
- "endpoint" must be one endpoint key from the catalog, e.g. "image.txt2img".
- Do not guess params that aren't implied by the message — omit optional ones you're not confident about.
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
  // Cheap guard against runaway prompts from a pasted essay / huge code file.
  if (message.length > 4000) {
    res.status(400).json({ error: 'Message too long (max 4000 characters).' });
    return;
  }

  const prompt = SYSTEM_PROMPT + '\n\nUser request: ' + message;

  // Walk the model chain until one returns a usable routing decision.
  let route = null, modelUsed = null, fallbackUsed = false;
  const errors = [];
  for (const m of ROUTER_MODELS) {
    try {
      const raw = await callPrexzyChat(m, prompt);
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
      error: 'All Prexzy router models failed to produce a routing decision.',
      detail: errors.join(' | ')
    });
    return;
  }

  let fallbackNote = fallbackUsed
    ? `Primary router (GPT-5.4) was unavailable — routed with ${modelUsed} instead.`
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
 * Call one Prexzy chat model with the routing prompt.
 * Prexzy chat endpoints are GET ?q=... and return JSON; the answer text
 * lives in different fields per endpoint (.result / .response / .answer).
 * ------------------------------------------------------------------------- */
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
    try { data = JSON.parse(text); } catch (_) { /* plain-text answer */ }
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
    return JSON.stringify(data); // last resort: maybe it IS the route object
  }
  return text;
}

/* -------------------------------------------------------------------------
 * The router models don't support Anthropic-style forced tool calls, so we
 * instruct them to emit raw JSON and extract it defensively here: strip
 * markdown fences, grab the first {...} block, and JSON.parse it.
 * ------------------------------------------------------------------------- */
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
