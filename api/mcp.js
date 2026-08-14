/**
 * api/mcp.js — Generic MCP (Model Context Protocol) proxy
 *
 * Zero-dependency Streamable HTTP / JSON-RPC client for remote MCP servers.
 * Fits Canton Node's Vanilla + Vercel style (no npm SDK required).
 *
 * POST body:
 *   {
 *     "action": "listTools" | "callTool" | "ping",
 *     "url": "https://mcp.example.com/mcp",
 *     "headers": { "Authorization": "Bearer …" },   // optional
 *     "tool": "tool_name",                           // callTool only
 *     "arguments": { … }                             // callTool only
 *   }
 *
 * Security:
 *   - HTTPS only
 *   - No stdio / no local process spawn
 *   - Header allow-list (Authorization, X-*, Api-Key style)
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
    return u.protocol === 'https:' || (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
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
      lower.startsWith('x-') ||
      lower === 'ocp-apim-subscription-key'
    ) {
      out[key] = v.slice(0, 2048);
    }
  }
  return out;
}

async function mcpRpc(url, headers, method, params, id = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {})
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...headers
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    // Streamable HTTP may return plain JSON or SSE-framed JSON
    let data;
    if (text.trim().startsWith('data:')) {
      const lines = text.split('\n').filter((l) => l.startsWith('data:'));
      const last = lines[lines.length - 1] || '';
      data = JSON.parse(last.replace(/^data:\s*/, '') || '{}');
    } else {
      data = JSON.parse(text || '{}');
    }

    if (data.error) {
      const msg = data.error.message || JSON.stringify(data.error);
      throw new Error(`MCP error: ${msg}`);
    }

    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

async function initializeSession(url, headers) {
  // Best-effort initialize; many servers accept tools/list without a prior session.
  try {
    await mcpRpc(url, headers, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'canton-node', version: '1.0.0' }
    }, 0);
  } catch (err) {
    console.warn('[mcp] initialize skipped/failed:', err.message);
  }
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
    const url = String(body.url || '').trim();
    const headers = sanitizeHeaders(body.headers);

    if (!url) return json(res, 400, { ok: false, error: 'url is required' });
    if (!isHttpsUrl(url)) {
      return json(res, 400, { ok: false, error: 'Only HTTPS MCP URLs are allowed (localhost exception for dev)' });
    }

    if (action === 'ping') {
      await initializeSession(url, headers);
      return json(res, 200, { ok: true, message: 'reachable' });
    }

    if (action === 'listTools') {
      await initializeSession(url, headers);
      const result = await mcpRpc(url, headers, 'tools/list', {}, 1);
      const tools = Array.isArray(result?.tools) ? result.tools : [];
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

      await initializeSession(url, headers);
      const result = await mcpRpc(url, headers, 'tools/call', {
        name: tool,
        arguments: args
      }, 2);

      return json(res, 200, { ok: true, result });
    }

    return json(res, 400, { ok: false, error: 'Unknown action. Use listTools | callTool | ping' });
  } catch (err) {
    console.error('[mcp]', err);
    return json(res, 500, {
      ok: false,
      error: err.name === 'AbortError' ? 'MCP request timed out' : (err.message || 'MCP request failed')
    });
  }
}
