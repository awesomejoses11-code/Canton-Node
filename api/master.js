/* =========================================================================
 * api/master.js — Master Agent orchestrator (step 3.1 — OpenRouter does real work)
 *
 * PIVOT (this revision): Prexzy's chat endpoints keep flaking under load and
 * there was no fallback — one failed call and the user got nothing. For
 * agent_id "chat" and "web" this file no longer just returns a routing
 * decision and hopes the browser's single Prexzy call succeeds. Instead it:
 *
 *   1. ROTATES across a chain of Prexzy text endpoints server-side. One
 *      endpoint failing just advances to the next; the request only fails
 *      if every endpoint in the chain fails.
 *   2. If the whole Prexzy chain fails, GENERATES the answer itself using
 *      the same OpenRouter free-model chain already used for routing — so
 *      OpenRouter isn't just a JSON-only coordinator anymore, it can do the
 *      actual work. For "web" specifically, it can also enable OpenRouter's
 *      web-search plugin as a genuine internet fallback — gated behind
 *      OPENROUTER_ENABLE_WEB_SEARCH (see note below; this is NOT free).
 *
 * Every other agent_id (image, music, video, code, tts, html2image,
 * image2html) is UNCHANGED: this file only returns a routing decision and
 * the browser still executes the call via PrexzyAPI.call(), so those
 * agents' client-side daily quotas keep working exactly as before.
 *
 * ⚠ CONTRACT CHANGE for the browser: when agent_id is "chat" or "web" the
 * JSON response now includes `server_executed: true`, `result` (the actual
 * answer text), `source` ('prexzy' | 'openrouter' | 'openrouter-online'),
 * and `prexzy_attempts` (which endpoints were tried and why they failed).
 * master-client.js needs to check `server_executed` and render `result`
 * directly — it must NOT call PrexzyAPI.call(route.endpoint, route.params)
 * again for these two agents, or it'll double-fetch. One open item this
 * doesn't solve yet: because the Prexzy call now happens server-side, the
 * browser's client-side Quota counters for "chat"/"web" are NOT touched by
 * this path (they still work normally if those specialist agent cards are
 * opened directly instead of through the Master Agent composer).
 *
 * ⚠ COST NOTE: OpenRouter's web-search plugin is billed separately from the
 * free-tier model chain — $4 per 1,000 results, not covered by the 50
 * req/day free cap. It is OFF by default. Set OPENROUTER_ENABLE_WEB_SEARCH
 * to a truthy value in Vercel's env vars to turn it on for the "web" agent's
 * last-resort fallback. Left off, "web" still gets an OpenRouter-generated
 * answer when every Prexzy endpoint fails — it just won't have live
 * internet access on that specific last-resort path.
 *
 * Endpoint params below are curl-confirmed, not guessed — don't "fix" them
 * without re-testing against the live API first:
 *   /ai/aiwriter-chat  wants  { prompt }   — reconfirmed live 2026-08-13
 *   /ai/askgpt5        wants  { prompt }   (sending {q} instead 400s: "Parameter \"prompt\" is required")
 *   /ai/mistral        wants  { prompt }   (same 400 as askgpt5 when sent {q})
 *   /ai/chatex         wants  { text }     (400s "Text parameter is required" if sent {prompt})
 *
 * NOTE ON DUPLICATION: ENDPOINT_DOCS mirrors the endpoint catalog in
 * js/api.js (path/params). api.js is written for the browser and can't be
 * required directly from this Node function without a bundler, so keep the
 * two in sync by hand. Worth extracting into a shared endpoints.json once
 * the catalog grows past this size.
 * ========================================================================= */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PREXZY_BASE_URL = 'https://prexzyapis.com';
const PREXZY_TIMEOUT_MS = 12000;

// See "COST NOTE" above — off unless explicitly enabled in env vars.
const WEB_SEARCH_FALLBACK_ENABLED = /^(1|true|yes)$/i.test(process.env.OPENROUTER_ENABLE_WEB_SEARCH || '');

/* -------------------------------------------------------------------------
 * Router model chain. `tool_choice` is always 'auto' — several free-tier
 * providers behind OpenRouter reject a forced/named tool_choice ("inference-
 * enforced tool_choice is not supported"), since forcing a specific function
 * needs guided-generation support most free backends don't implement. This
 * same chain is reused below (callOpenRouterGenerate) to actually answer
 * chat/web requests once every Prexzy endpoint has failed.
 * ------------------------------------------------------------------------- */
const ROUTER_MODELS = [
  { model: 'openrouter/free',            label: 'Free Models Router' },
  { model: 'openai/gpt-oss-20b:free',    label: 'GPT-OSS 20B'        },
  { model: 'google/gemma-4-31b-it:free', label: 'Gemma 4 31B'        }
];

// Mirrors tools.json ids, kept here so we can validate the model's pick
// server-side without re-parsing tools.json at request time.
const AGENT_IDS = [
  'image', 'music', 'video', 'image2html',
  'html2image', 'tts', 'code', 'web', 'chat'
];

// endpoint key -> agent_id, for validating the model didn't cross-wire them.
// null = shared chat.* endpoint, valid for any agent in SHARED_CHAT_ENDPOINT_AGENTS.
const ENDPOINT_TO_AGENT = {
  'image.txt2img': 'image', 'image.genimage': 'image', 'image.aiwriter': 'image', 'image.dalle': 'image',
  'music.aimelody': 'music', 'music.text2music.create': 'music',
  'video.create': 'video',
  'chat.aiwriterChat': null, // new: /ai/aiwriter-chat, reconfirmed working — shared like the others below
  'chat.chatex': null,
  'chat.askgpt5': null,
  'chat.mistral': null,
  'chat.writer': 'chat', 'chat.summarize': 'chat',
  'html2image.direct': 'html2image', 'html2image.json': 'html2image',
  'tts.default': 'tts',
  'code.compile.python': 'code', 'code.compile.js': 'code', 'code.compile.java': 'code',
  'code.compile.c': 'code', 'code.compile.cpp': 'code', 'code.compile.csharp': 'code',
  'code.convert.python': 'code', 'code.convert.js': 'code', 'code.convert.java': 'code',
  'code.convert.cpp': 'code', 'code.convert.php': 'code'
};
// chat.aiwriterChat / chat.chatex / chat.askgpt5 / chat.mistral are valid for these agents specifically.
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
web          chat.aiwriterChat    {prompt}
web          chat.chatex          {text, web:true}
web          chat.askgpt5         {prompt, web:true}
web          chat.mistral         {prompt, web:true}
chat         chat.aiwriterChat    {prompt}
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

// Ordered Prexzy fallback chains for the two text agents. aiwriter-chat goes
// first in both — reconfirmed working live via curl on 2026-08-13, while the
// others are longer-standing but flakier under load. Each build(msg) uses
// the raw user message directly rather than the router model's extracted
// params, so a routing hiccup can't also break the actual generation.
const CHAT_CHAIN = [
  { endpoint: 'chat.aiwriterChat', build: (msg) => qsUrl('/ai/aiwriter-chat', { prompt: msg }) },
  { endpoint: 'chat.askgpt5',      build: (msg) => qsUrl('/ai/askgpt5',       { prompt: msg }) },
  { endpoint: 'chat.mistral',      build: (msg) => qsUrl('/ai/mistral',       { prompt: msg }) },
  { endpoint: 'chat.chatex',       build: (msg) => qsUrl('/ai/chatex',        { text: msg })   }
];
const WEB_CHAIN = [
  { endpoint: 'chat.askgpt5',      build: (msg) => qsUrl('/ai/askgpt5', { prompt: msg, websearch: 'true' }) },
  { endpoint: 'chat.mistral',      build: (msg) => qsUrl('/ai/mistral', { prompt: msg, websearch: 'true' }) },
  { endpoint: 'chat.chatex',       build: (msg) => qsUrl('/ai/chatex',  { text: msg, web: 'true' })          },
  // No web-search flag confirmed for aiwriter-chat yet — a best-effort
  // non-web answer still beats nothing if the three above all fail.
  { endpoint: 'chat.aiwriterChat', build: (msg) => qsUrl('/ai/aiwriter-chat', { prompt: msg }) }
];

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

  // 1) Get a routing decision — unchanged mechanism, still needed for every
  //    agent (including chat/web, to keep the response shape consistent and
  //    to surface the model's reasoning even when we go on to execute below).
  let route = null, modelUsed = null, fallbackUsed = false;
  const routeErrors = [];
  for (const m of ROUTER_MODELS) {
    try {
      const parsed = await callOpenRouterRoute(apiKey, m, message);
      if (parsed && AGENT_IDS.includes(parsed.agent_id) && ENDPOINT_TO_AGENT[parsed.endpoint] !== undefined) {
        route = parsed;
        modelUsed = m.label;
        fallbackUsed = m !== ROUTER_MODELS[0];
        break;
      }
      if (!parsed) {
        routeErrors.push(m.label + ': no JSON found in model output');
      } else if (!AGENT_IDS.includes(parsed.agent_id)) {
        routeErrors.push(m.label + ': invalid agent_id "' + parsed.agent_id + '"');
      } else {
        routeErrors.push(m.label + ': invalid endpoint "' + parsed.endpoint + '"');
      }
    } catch (e) {
      routeErrors.push(m.label + ': ' + e.message);
    }
  }

  if (!route) {
    res.status(502).json({
      error: 'All OpenRouter free models failed to produce a routing decision.',
      detail: routeErrors.join(' | ')
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

  const routedParams = sanitizeParams(route.params);

  // 2) chat / web: actually DO the work now (Prexzy rotation, then
  //    OpenRouter generation as the terminal fallback) instead of leaving it
  //    to a single client-side Prexzy call.
  if (route.agent_id === 'chat' || route.agent_id === 'web') {
    const exec = await runTextAgent(apiKey, route.agent_id, message);
    res.status(200).json({
      agent_id: route.agent_id,
      endpoint: exec.endpoint,
      params: exec.params,
      result: exec.text,
      source: exec.source,
      server_executed: true,
      prexzy_attempts: exec.attempts,
      reasoning: typeof route.reasoning === 'string' ? route.reasoning : '',
      fallback_note: [fallbackNote, exec.note].filter(Boolean).join(' ') || null,
      model_used: exec.source === 'prexzy' ? modelUsed : (exec.modelUsed || modelUsed),
      fallback_used: fallbackUsed || exec.source !== 'prexzy'
    });
    return;
  }

  // 3) Every other agent: unchanged — routing decision only, browser executes.
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

/* -------------------------------------------------------------------------
 * runTextAgent — rotate across Prexzy text endpoints, then fall back to
 * OpenRouter generation (optionally with live web search) if all of them
 * fail. Returns { source, endpoint, params, text, attempts, modelUsed, note }.
 * ------------------------------------------------------------------------- */
async function runTextAgent(apiKey, agentId, message) {
  const chain = agentId === 'web' ? WEB_CHAIN : CHAT_CHAIN;
  const attempts = [];

  for (const step of chain) {
    try {
      const text = await tryPrexzyText(step.build(message));
      if (text) {
        return {
          source: 'prexzy',
          endpoint: step.endpoint,
          params: { prompt: message },
          text,
          attempts,
          note: attempts.length
            ? `Recovered on ${step.endpoint} after ${attempts.length} Prexzy endpoint(s) failed.`
            : null
        };
      }
      attempts.push({ endpoint: step.endpoint, error: 'empty response' });
    } catch (e) {
      attempts.push({ endpoint: step.endpoint, error: e.message });
    }
  }

  // Every Prexzy endpoint in the chain failed — generate directly.
  const useWebPlugin = agentId === 'web' && WEB_SEARCH_FALLBACK_ENABLED;
  const failedList = attempts.map(a => a.endpoint).join(', ');
  for (const m of ROUTER_MODELS) {
    try {
      const gen = await callOpenRouterGenerate(apiKey, m, message, useWebPlugin);
      if (gen.text) {
        return {
          source: gen.usedWeb ? 'openrouter-online' : 'openrouter',
          endpoint: gen.usedWeb ? 'openrouter.generate:online' : 'openrouter.generate',
          params: { prompt: message },
          text: gen.text,
          attempts,
          modelUsed: m.label,
          note: `All ${chain.length} Prexzy text endpoint(s) failed (${failedList}) — answered directly via ${m.label}` +
                (gen.usedWeb ? ' with live web search.' : '.')
        };
      }
      attempts.push({ endpoint: 'openrouter:' + m.model, error: 'empty response' });
    } catch (e) {
      attempts.push({ endpoint: 'openrouter:' + m.model, error: e.message });
    }
  }

  return {
    source: 'error',
    endpoint: null,
    params: { prompt: message },
    text: null,
    attempts,
    modelUsed: null,
    note: `All ${chain.length} Prexzy text endpoint(s) and all ${ROUTER_MODELS.length} OpenRouter fallback model(s) failed.`
  };
}

/** One Prexzy text-endpoint attempt, with a timeout so a hung endpoint doesn't stall the whole chain. */
async function tryPrexzyText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREXZY_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();
    if (json && json.status === false) throw new Error(json.message || 'Prexzy reported failure');
    return extractText(json);
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort text extraction — Prexzy endpoints don't all shape their JSON the same way. */
function extractText(json) {
  if (!json) return null;
  if (typeof json === 'string') return json.trim() || null;
  const r = json.result;
  if (typeof r === 'string') return r.trim() || null;
  if (r && Array.isArray(r.text)) return r.text.join('\n').trim() || null;
  if (r && typeof r.text === 'string') return r.text.trim() || null;
  if (r && typeof r.answer === 'string') return r.answer.trim() || null;
  if (r && typeof r.message === 'string') return r.message.trim() || null;
  if (typeof json.answer === 'string') return json.answer.trim() || null;
  if (typeof json.text === 'string') return json.text.trim() || null;
  if (typeof json.response === 'string') return json.response.trim() || null;
  if (typeof json.message === 'string' && json.message.toLowerCase() !== 'success') return json.message.trim() || null;
  return null;
}

function qsUrl(path, params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    usp.append(k, String(v));
  }
  const query = usp.toString();
  return PREXZY_BASE_URL + path + (query ? ('?' + query) : '');
}

/* -------------------------------------------------------------------------
 * Call one OpenRouter model purely to GENERATE an answer (not to route).
 * Reuses ROUTER_MODELS so the free-tier daily cap is shared consistently
 * with the routing calls above. `useWebPlugin` adds OpenRouter's web-search
 * plugin — see the COST NOTE at the top of this file before flipping it on.
 * ------------------------------------------------------------------------- */
async function callOpenRouterGenerate(apiKey, modelCfg, message, useWebPlugin) {
  const body = {
    model: modelCfg.model,
    messages: [
      { role: 'system', content: 'You are a helpful assistant. Answer the user directly and concisely.' },
      { role: 'user', content: message }
    ],
    max_tokens: 800
  };
  if (useWebPlugin) {
    // Plugin form (not the ":online" model-slug suffix) — works the same
    // way regardless of which model in the chain ends up handling it.
    body.plugins = [{ id: 'web', max_results: 3 }];
  }

  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + apiKey,
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
  const text = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
  return { text: text || null, usedWeb: !!useWebPlugin };
}

/* -------------------------------------------------------------------------
 * Call one OpenRouter model with the ROUTING prompt (tool call preferred,
 * plain-text JSON parsed defensively as a fallback either way, since a
 * model can ignore tool_choice).
 * ------------------------------------------------------------------------- */
async function callOpenRouterRoute(apiKey, modelCfg, message) {
  const body = {
    model: modelCfg.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: message }
    ],
    max_tokens: 500,
    tools: [{
      type: 'function',
      function: {
        name: 'route_request',
        description: 'Route the user request to the correct agent + endpoint with extracted params.',
        parameters: ROUTE_SCHEMA
      }
    }],
    // 'auto', not a forced/named choice — see note on ROUTER_MODELS above.
    tool_choice: 'auto',
    // Second, independent constraint layer: OpenRouter's structured-outputs
    // mode (mirrors Anthropic's output_config.format / json_schema —
    // constrained decoding, not a "please return JSON" instruction). Doesn't
    // depend on tool-calling support, so a model that rejects forced
    // tool_choice can still honor this. Unsupported params are ignored per
    // OpenRouter's docs, so it's safe to send to every model in the chain.
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'route_request', strict: true, schema: ROUTE_SCHEMA }
    }
  };

  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + apiKey,
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
  const extracted = extractRouteJson(msg.content);
  if (extracted) return extracted;

  const snippet = (msg.content || '(empty response)').slice(0, 200);
  throw new Error('no tool call and no parseable JSON — raw: ' + snippet);
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
