/* =========================================================================
 * api/master.js — Master Agent orchestrator (step 3.2 — Prexzy text dropped)
 *
 * PIVOT (this revision): Prexzy's text endpoints (chatex/askgpt5/mistral/
 * aiwriter-chat) were unstable enough — even after the earlier param-name
 * fixes — that rotating through all of them before falling back to
 * OpenRouter just added latency without adding reliability: up to 4
 * sequential attempts at a 12s timeout each (~48s worst case) before ever
 * reaching the fallback that actually worked. For agent_id "chat" and "web"
 * this file no longer touches Prexzy at all — the OpenRouter free-model
 * chain (the same one used for routing) generates the answer directly.
 *
 * Every other agent_id (image, music, video, code, tts, html2image,
 * image2html) is UNCHANGED: this file only returns a routing decision and
 * the browser still executes the call via PrexzyAPI.call(), so those
 * agents' client-side daily quotas keep working exactly as before.
 *
 * ⚠ "web" trade-off: Prexzy's chat endpoints had a free `websearch:true`
 * flag. OpenRouter has an equivalent, but it's billed separately from the
 * free-tier model chain ($4/1,000 results — not covered by the 50 req/day
 * free cap) and stays OFF by default (OPENROUTER_ENABLE_WEB_SEARCH env var
 * to turn it on). Left off, "web" now answers from the model's own
 * knowledge with no live search — flagged in fallback_note so it's visible
 * in the UI rather than silently degraded.
 *
 * ⚠ CONTRACT CHANGE (from the previous revision): field renamed
 * `prexzy_attempts` → `generation_attempts`, since it now lists which
 * OpenRouter models were tried and why any of them failed before one
 * succeeded, not Prexzy endpoints. Not consumed anywhere in master-client.js
 * today, so the rename is safe. When agent_id is "chat" or "web" the JSON
 * response includes `server_executed: true`, `result` (the actual answer
 * text), `source` ('openrouter' | 'openrouter-online'), and
 * `generation_attempts`. master-client.js must check `server_executed` and
 * render `result` directly, not call PrexzyAPI.call() again for these two
 * agents. Client-side Quota counters for "chat"/"web" are still only
 * touched when those specialist agent cards are opened directly instead of
 * through the Master Agent composer.
 *
 * Endpoint params below are curl-confirmed, not guessed — don't "fix" them
 * without re-testing against the live API first:
 *   /ai/aiwriter-chat  wants  { prompt }   — reconfirmed live 2026-08-13
 *   /ai/askgpt5        wants  { prompt }   (sending {q} instead 400s: "Parameter \"prompt\" is required")
 *   /ai/mistral        wants  { prompt }   (same 400 as askgpt5 when sent {q})
 *   /ai/chatex         wants  { text }     (400s "Text parameter is required" if sent {prompt})
 * These endpoints are no longer called by this file, but js/api.js still
 * defines them for the specialist chat/web agent cards (opened directly,
 * outside the Master Agent) — same param rules apply there.
 *
 * NOTE ON DUPLICATION: ENDPOINT_DOCS mirrors the endpoint catalog in
 * js/api.js (path/params). api.js is written for the browser and can't be
 * required directly from this Node function without a bundler, so keep the
 * two in sync by hand. Worth extracting into a shared endpoints.json once
 * the catalog grows past this size.
 * ========================================================================= */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

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

// Dedicated chain for code.convert.* — Devstral is Mistral's coding-specialist
// model and free on OpenRouter; tried before falling through to the general
// ROUTER_MODELS chain, which can still write code but isn't specialized for it.
// Deliberately NOT used for code.compile.* — no model in either chain can
// actually execute code, only generate text that looks like it did, so
// compile stays on Prexzy where a real sandbox runs it.
const CODE_MODELS = [
  { model: 'mistralai/devstral-2512:free',    label: 'Devstral 2' },
  { model: 'mistralai/devstral-small:free',   label: 'Devstral Small' }
];
const CONVERT_TARGET_LANG = {
  'code.convert.python': 'Python',
  'code.convert.js':     'JavaScript',
  'code.convert.java':   'Java',
  'code.convert.cpp':    'C++',
  'code.convert.php':    'PHP'
};

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

  // 2) chat / web: generate the answer directly via OpenRouter — no Prexzy
  //    involved (see PIVOT note at the top of this file).
  if (route.agent_id === 'chat' || route.agent_id === 'web') {
    const exec = await runTextAgent(apiKey, route.agent_id, message);
    res.status(200).json({
      agent_id: route.agent_id,
      endpoint: exec.endpoint,
      params: exec.params,
      result: exec.text,
      source: exec.source,
      server_executed: true,
      generation_attempts: exec.attempts,
      reasoning: typeof route.reasoning === 'string' ? route.reasoning : '',
      fallback_note: [fallbackNote, exec.note].filter(Boolean).join(' ') || null,
      model_used: exec.modelUsed || modelUsed,
      fallback_used: fallbackUsed || exec.attempts.length > 0
    });
    return;
  }

  // 2b) code.convert.* (language translation) — same reasoning: an LLM can
  //     genuinely do this, so it's server-executed via the Devstral chain.
  //     code.compile.* is deliberately excluded — see CODE_MODELS note above
  //     — and falls through to branch 3 unchanged (browser → Prexzy).
  if (route.agent_id === 'code' && /^code\.convert\./.test(route.endpoint)) {
    if (!routedParams.code) {
      res.status(200).json({
        agent_id: route.agent_id,
        endpoint: route.endpoint,
        params: routedParams,
        result: null,
        source: 'error',
        server_executed: true,
        generation_attempts: [],
        reasoning: typeof route.reasoning === 'string' ? route.reasoning : '',
        fallback_note: [fallbackNote, 'No code was found in the message to convert.'].filter(Boolean).join(' '),
        model_used: modelUsed,
        fallback_used: fallbackUsed
      });
      return;
    }
    const exec = await runCodeConvert(apiKey, route.endpoint, routedParams.code, routedParams.from);
    res.status(200).json({
      agent_id: route.agent_id,
      endpoint: route.endpoint,
      params: routedParams,
      result: exec.text,
      source: exec.text ? 'openrouter' : 'error',
      server_executed: true,
      generation_attempts: exec.attempts,
      reasoning: typeof route.reasoning === 'string' ? route.reasoning : '',
      fallback_note: [fallbackNote, exec.note].filter(Boolean).join(' ') || null,
      model_used: exec.modelUsed || modelUsed,
      fallback_used: fallbackUsed || !!exec.attempts.length
    });
    return;
  }

  // 3) Every other agent (including code.compile.*): unchanged — routing
  //    decision only, browser executes via PrexzyAPI.call().
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
 * runTextAgent — generate the answer directly via the OpenRouter free-model
 * chain (no Prexzy involved). Returns the same shape as before so
 * master-client.js needs no change: { source, endpoint, params, text,
 * attempts, modelUsed, note }.
 * ------------------------------------------------------------------------- */
async function runTextAgent(apiKey, agentId, message) {
  const useWebPlugin = agentId === 'web' && WEB_SEARCH_FALLBACK_ENABLED;
  const attempts = [];

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
          note: (agentId === 'web' && !gen.usedWeb)
            ? 'Answered from the model\'s own knowledge — live web search is off by default ' +
              '(OpenRouter\'s web plugin is billed separately; set OPENROUTER_ENABLE_WEB_SEARCH to turn it on).'
            : null
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
    note: `All ${ROUTER_MODELS.length} OpenRouter model(s) failed to generate an answer.`
  };
}

/* -------------------------------------------------------------------------
 * runCodeConvert — code.convert.* only (never code.compile.*, see the note
 * on CODE_MODELS above). Target language comes from the endpoint key itself
 * (e.g. "code.convert.python" → Python), same convention api.js already
 * uses. Tries the Devstral chain first, then falls through to the general
 * ROUTER_MODELS chain if both Devstral variants are down.
 * ------------------------------------------------------------------------- */
async function runCodeConvert(apiKey, endpoint, code, fromLang) {
  const targetLang = CONVERT_TARGET_LANG[endpoint];
  const attempts = [];
  const systemPrompt =
    `Convert the given code to ${targetLang}${fromLang ? ` from ${fromLang}` : ''}. ` +
    'Preserve behavior exactly. Respond with ONLY the converted code — ' +
    'no explanation, no markdown code fences, no commentary before or after.';

  for (const m of [...CODE_MODELS, ...ROUTER_MODELS]) {
    try {
      const gen = await callOpenRouterGenerate(apiKey, m, code, false, systemPrompt, 1500);
      if (gen.text) {
        return {
          text: stripCodeFences(gen.text),
          attempts,
          modelUsed: m.label,
          note: attempts.length ? `Recovered on ${m.label} after ${attempts.length} model(s) failed.` : null
        };
      }
      attempts.push({ endpoint: 'openrouter:' + m.model, error: 'empty response' });
    } catch (e) {
      attempts.push({ endpoint: 'openrouter:' + m.model, error: e.message });
    }
  }

  return {
    text: null,
    attempts,
    modelUsed: null,
    note: `All ${CODE_MODELS.length + ROUTER_MODELS.length} OpenRouter model(s) failed to convert the code.`
  };
}

// Models sometimes wrap output in ```lang fences despite being told not to —
// strip defensively rather than showing the fences as part of the "code".
function stripCodeFences(text) {
  const s = text.trim();
  const fenced = /^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/.exec(s);
  return fenced ? fenced[1].trim() : s;
}

/* -------------------------------------------------------------------------
 * Call one OpenRouter model purely to GENERATE an answer (not to route).
 * `useWebPlugin` adds OpenRouter's web-search plugin — see the COST NOTE at
 * the top of this file before flipping it on. `systemPrompt`/`maxTokens`
 * let callers other than the chat/web path (e.g. code conversion below)
 * reuse this without inheriting the "helpful assistant" framing.
 * ------------------------------------------------------------------------- */
async function callOpenRouterGenerate(apiKey, modelCfg, message, useWebPlugin, systemPrompt, maxTokens) {
  const body = {
    model: modelCfg.model,
    messages: [
      { role: 'system', content: systemPrompt || 'You are a helpful assistant. Answer the user directly and concisely.' },
      { role: 'user', content: message }
    ],
    max_tokens: maxTokens || 800
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
