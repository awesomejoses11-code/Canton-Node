/**
 * api/mcp.js — Generic MCP (Model Context Protocol) proxy
 *
 * Zero-dependency Streamable HTTP / JSON-RPC client for remote MCP servers.
 * Fits Canton Node's Vanilla + Vercel style (no npm SDK required).
 *
 * Session flow (MCP Streamable HTTP, e.g. CoinGecko):
 *   1. POST initialize → read Mcp-Session-Id response header
 *   2. POST notifications/initialized (with session id)
 *   3. POST tools/list | tools/call (with session id)
 *
 * POST body:
 *   {
 *     "action": "listTools" | "callTool" | "ping",
 *     "url": "https://mcp.example.com/mcp",
 *     "headers": { "Authorization": "Bearer …" },   // optional
 *     "tool": "tool_name",                           // callTool only
 *     "arguments": { … }                             // callTool only
 *   }
 */

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 45000;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function isHttpsUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/** Strip trailing slash except for bare origin paths — CoinGecko 404s on /mcp/ */
function normalizeMcpUrl(raw) {
  const u = new URL(String(raw).trim());
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }
  return u.toString();
}

function sanitizeHeaders(input) {
  if (!input || typeof input !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof k !== 'string' || typeof v !== 'string') continue;
    const key = k.trim();
    const lower = key.toLowerCase();
    if (
      lower === 'authorization' ||
      lower === 'api-key' ||
      lower === 'x-api-key' ||
      lower === 'x-cg-pro-api-key' ||
      lower === 'x-cg-demo-api-key' ||
      lower.startsWith('x-') ||
      lower === 'ocp-apim-subscription-key'
    ) {
      out[key] = v.slice(0, 2048);
    }
  }
  return out;
}

function headerGet(headers, name) {
  if (!headers || typeof headers.get !== 'function') return null;
  return headers.get(name) || headers.get(name.toLowerCase()) || headers.get(name.toUpperCase());
}

function parseMcpBody(text) {
  const t = String(text || '').trim();
  if (!t) return {};
  // Streamable HTTP may return plain JSON or SSE-framed JSON
  if (t.startsWith('data:') || t.includes('\ndata:')) {
    const lines = t.split('\n').filter((l) => l.startsWith('data:'));
    const last = lines[lines.length - 1] || '';
    return JSON.parse(last.replace(/^data:\s*/, '') || '{}');
  }
  return JSON.parse(t);
}

/**
 * Low-level MCP JSON-RPC over Streamable HTTP.
 * Returns { result, sessionId, rawHeaders }.
 */
async function mcpRpc(url, headers, method, params, id, sessionId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const payload = { jsonrpc: '2.0' };
    // Notifications omit id
    if (id !== null && id !== undefined) payload.id = id;
    payload.method = method;
    if (params !== undefined) payload.params = params;

    const reqHeaders = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...headers
    };
    if (sessionId) {
      reqHeaders['Mcp-Session-Id'] = sessionId;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: reqHeaders,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await res.text();
    const newSession =
      headerGet(res.headers, 'mcp-session-id') ||
      headerGet(res.headers, 'Mcp-Session-Id') ||
      sessionId ||
      null;

    if (!res.ok) {
      throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    // notifications often return empty body / 202
    if (!text || !String(text).trim()) {
      return { result: null, sessionId: newSession };
    }

    let data;
    try {
      data = parseMcpBody(text);
    } catch (e) {
      throw new Error('MCP invalid JSON response: ' + e.message + ' — ' + text.slice(0, 120));
    }

    if (data.error) {
      const msg = data.error.message || JSON.stringify(data.error);
      throw new Error(`MCP error: ${msg}`);
    }

    return { result: data.result, sessionId: newSession };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full session handshake for servers that require Mcp-Session-Id
 * (CoinGecko, many Streamable HTTP hosts).
 */
async function openSession(url, headers) {
  const init = await mcpRpc(
    url,
    headers,
    'initialize',
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'canton-node', version: '1.0.0' }
    },
    0,
    null
  );

  const sessionId = init.sessionId;
  if (sessionId) {
    // Spec: after InitializeResult, client sends notifications/initialized
    try {
      await mcpRpc(url, headers, 'notifications/initialized', {}, null, sessionId);
    } catch (err) {
      // Some servers ignore this notification; don't fail the whole flow
      console.warn('[mcp] notifications/initialized:', err.message);
    }
  }

  return { sessionId: sessionId || null, initializeResult: init.result };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = body.action || 'listTools';
    const rawUrl = String(body.url || '').trim();
    const headers = sanitizeHeaders(body.headers);

    if (!rawUrl) return json(res, 400, { ok: false, error: 'url is required' });
    if (!isHttpsUrl(rawUrl)) {
      return json(res, 400, {
        ok: false,
        error: 'Only HTTPS MCP URLs are allowed (localhost exception for dev)'
      });
    }

    const url = normalizeMcpUrl(rawUrl);

    if (action === 'ping') {
      const session = await openSession(url, headers);
      return json(res, 200, {
        ok: true,
        message: 'reachable',
        session: !!session.sessionId,
        serverInfo: session.initializeResult && session.initializeResult.serverInfo
      });
    }

    if (action === 'listTools') {
      const session = await openSession(url, headers);
      const listed = await mcpRpc(
        url,
        headers,
        'tools/list',
        {},
        1,
        session.sessionId
      );
      const tools = Array.isArray(listed.result && listed.result.tools)
        ? listed.result.tools
        : [];
      return json(res, 200, {
        ok: true,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description || '',
          inputSchema: t.inputSchema || t.input_schema || { type: 'object' }
        }))
      });
    }

    if (action === 'callTool') {
      const tool = String(body.tool || '').trim();
      if (!tool) return json(res, 400, { ok: false, error: 'tool is required' });
      const args = body.arguments && typeof body.arguments === 'object' ? body.arguments : {};

      const session = await openSession(url, headers);
      const called = await mcpRpc(
        url,
        headers,
        'tools/call',
        { name: tool, arguments: args },
        2,
        session.sessionId
      );

      return json(res, 200, { ok: true, result: called.result });
    }

    return json(res, 400, {
      ok: false,
      error: 'Unknown action. Use listTools | callTool | ping'
    });
  } catch (err) {
    console.error('[mcp]', err);
    return json(res, 500, {
      ok: false,
      error:
        err.name === 'AbortError'
          ? 'MCP request timed out'
          : err.message || 'MCP request failed'
    });
  }
}
