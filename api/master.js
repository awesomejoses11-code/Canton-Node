/* =========================================================================
 * api/master.js — Master Agent orchestrator (step 3)
 *
 * Runs server-side ONLY because this is the one place ANTHROPIC_API_KEY is
 * used — never expose it to the client. Takes a natural-language request,
 * asks Claude to pick the right specialist (tools.json) + endpoint (api.js)
 * and extract call params, and hands that routing decision back to the
 * browser. The browser then executes the actual Prexzy call itself via
 * PrexzyAPI.call(), same as every other path — this endpoint never talks
 * to Prexzy directly.
 *
 * NOTE ON DUPLICATION: ENDPOINT_DOCS below mirrors the endpoint catalog in
 * js/api.js (path/params), because api.js is written for the browser
 * (`window` global, fetch-building closures) and can't be required directly
 * from a Node serverless function without a bundler. If you add/change an
 * endpoint in api.js, update ENDPOINT_DOCS to match. Worth extracting into
 * a shared endpoints.json once the catalog grows past this size.
 * ========================================================================= */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001'; // fast + cheap — this is a classification task, not a chat

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
  'chat.askgpt5': null, // shared by image2html / web / chat — validated by agent_id context instead
  'chat.mistral': null,
  'chat.writer': 'chat', 'chat.summarize': 'chat',
  'html2image.direct': 'html2image', 'html2image.json': 'html2image',
  'tts.default': 'tts',
  'code.compile.python': 'code', 'code.compile.js': 'code', 'code.compile.java': 'code',
  'code.compile.c': 'code', 'code.compile.cpp': 'code', 'code.compile.csharp': 'code',
  'code.convert.python': 'code', 'code.convert.js': 'code', 'code.convert.java': 'code',
  'code.convert.cpp': 'code', 'code.convert.php': 'code'
};
// chat.askgpt5 / chat.mistral are valid for these three agents specifically.
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
web          chat.askgpt5         {prompt, web:true}
web          chat.mistral         {prompt, web:true}
chat         chat.askgpt5         {prompt}
chat         chat.mistral         {prompt}
chat         chat.writer          {prompt}
chat         chat.summarize       {text}
`.trim();

const SYSTEM_PROMPT = `You are the routing layer for a multi-tool API platform. Given a user's request, pick exactly one agent_id and one endpoint from the catalog below, and extract only the params that endpoint needs from the user's message.

Catalog (agent_id, endpoint, required params — "?" means optional):
${ENDPOINT_DOCS}

Rules:
- Always call the route_request tool. Never respond in plain text.
- Pick the single best-fitting endpoint. Do not guess params that aren't implied by the message — omit optional ones you're not confident about.
- For code.compile.* / code.convert.* endpoints, "code" must be the actual code from the user's message.
- Keep "reasoning" to one short sentence.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server.' });
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
  // Cheap guard against runaway Anthropic spend from a pasted essay / huge code file.
  if (message.length > 4000) {
    res.status(400).json({ error: 'Message too long (max 4000 characters).' });
    return;
  }

  let anthropicResp;
  try {
    anthropicResp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: message }],
        tools: [{
          name: 'route_request',
          description: 'Route the user request to the correct agent + endpoint with extracted params.',
          input_schema: {
            type: 'object',
            properties: {
              agent_id: { type: 'string', enum: AGENT_IDS },
              endpoint: { type: 'string', description: 'One endpoint key from the catalog, e.g. "image.txt2img".' },
              params: {
                type: 'object',
                description: 'Only the fields the chosen endpoint needs.',
                properties: {
                  prompt: { type: 'string' },
                  text: { type: 'string' },
                  code: { type: 'string' },
                  from: { type: 'string' },
                  voice: { type: 'string' },
                  size: { type: 'string' },
                  steps: { type: 'string' },
                  style: { type: 'string' },
                  image: { type: 'string' },
                  lyrics: { type: 'string' },
                  title: { type: 'string' },
                  html: { type: 'string' },
                  width: { type: 'string' },
                  height: { type: 'string' },
                  stdin: { type: 'string' },
                  web: { type: 'boolean' }
                },
                additionalProperties: false
              },
              reasoning: { type: 'string' }
            },
            required: ['agent_id', 'endpoint', 'params', 'reasoning']
          }
        }],
        tool_choice: { type: 'tool', name: 'route_request' }
      })
    });
  } catch (e) {
    res.status(502).json({ error: 'Failed to reach Anthropic API: ' + e.message });
    return;
  }

  if (!anthropicResp.ok) {
    const bodyText = await safeText(anthropicResp);
    res.status(502).json({ error: `Anthropic API returned ${anthropicResp.status}`, detail: bodyText });
    return;
  }

  let data;
  try {
    data = await anthropicResp.json();
  } catch (e) {
    res.status(502).json({ error: 'Failed to parse Anthropic response.' });
    return;
  }

  const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'route_request');
  if (!toolUse) {
    res.status(502).json({ error: 'Model did not return a routing decision.' });
    return;
  }

  const route = toolUse.input || {};
  let fallbackNote = null;

  // Validate agent_id.
  if (!AGENT_IDS.includes(route.agent_id)) {
    res.status(502).json({ error: `Model returned unknown agent_id: ${route.agent_id}` });
    return;
  }

  // Validate endpoint belongs to that agent (shared chat.* endpoints get special-cased).
  const owner = ENDPOINT_TO_AGENT[route.endpoint];
  const validForSharedAgent = owner === null && SHARED_CHAT_ENDPOINT_AGENTS.includes(route.agent_id);
  if (owner === undefined) {
    res.status(502).json({ error: `Model returned unknown endpoint: ${route.endpoint}` });
    return;
  }
  if (owner !== route.agent_id && !validForSharedAgent) {
    fallbackNote = `Model paired "${route.endpoint}" with agent "${route.agent_id}", which didn't match — check the result carefully.`;
  }

  res.status(200).json({
    agent_id: route.agent_id,
    endpoint: route.endpoint,
    params: route.params || {},
    reasoning: route.reasoning || '',
    fallback_note: fallbackNote
  });
};

async function safeText(resp) {
  try { return await resp.text(); } catch (_) { return ''; }
}
