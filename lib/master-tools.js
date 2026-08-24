/* lib/master-tools.js — OpenAI-style tools for Master Agent (GLM-5.2 tool_stream)
 * Also recovers when the model writes tool calls as plain text instead of tool_calls.
 */
var kernelLib = null;
try { kernelLib = require('./kernel-lib'); } catch (_) { kernelLib = null; }

var TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the live web for current facts, docs, APIs, prices, news. Use the structured tool call — never write web_search as plain text in your answer.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (concise, specific)' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browse_url',
      description: 'Open a specific https URL and extract readable page text. Use structured tool call only — never write browse_url as plain text.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full https:// URL to read' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_connected_mcps',
      description: 'List the user\'s connected MCP servers and available tools for this session.',
      parameters: {
        type: 'object',
        properties: {
          detail: {
            type: 'string',
            enum: ['summary', 'full'],
            description: 'summary = server names; full = include tool names'
          }
        }
      }
    }
  }
];

async function duckDuckGoSearch(query) {
  try {
    var url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(String(query || '').slice(0, 200));
    var resp = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(14000)
    });
    if (!resp.ok) return { ok: false, error: 'Search HTTP ' + resp.status, results: [], urls: [] };
    var html = await resp.text();
    var results = [];
    var urls = [];
    var re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html)) && results.length < 6) {
      var href = m[1];
      var title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      var uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch (_) {} }
      if (!/^https?:\/\//i.test(href)) continue;
      urls.push(href);
      results.push({ title: title, url: href });
    }
    if (!results.length) {
      var re2 = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
      while ((m = re2.exec(html)) && results.length < 6) {
        var href2 = m[1];
        var title2 = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (/duckduckgo\.com|javascript:/i.test(href2)) continue;
        urls.push(href2);
        results.push({ title: title2, url: href2 });
      }
    }
    return { ok: true, results: results, urls: urls, count: results.length };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), results: [], urls: [] };
  }
}

function formatSearchForModel(search) {
  if (!search || !search.ok) {
    return JSON.stringify({
      ok: false,
      error: (search && search.error) || 'search failed',
      note: 'Do not claim you lack web search. Report empty/blocked results and answer from knowledge if needed.'
    });
  }
  if (!search.results.length) {
    return JSON.stringify({ ok: true, count: 0, results: [], note: 'No parseable SERP hits.' });
  }
  return JSON.stringify({
    ok: true,
    count: search.count,
    results: search.results.map(function (r, i) {
      return { rank: i + 1, title: r.title, url: r.url };
    })
  });
}

/**
 * Recover tool calls the model wrote as prose, e.g.
 *   web_search: "Abstract blockchain network details 2026"
 *   browse_url("https://...")
 */
function parseTextualToolCalls(text) {
  var s = String(text || '');
  var out = [];
  var seen = {};

  function add(name, args) {
    var key = name + ':' + JSON.stringify(args);
    if (seen[key]) return;
    seen[key] = true;
    out.push({
      id: 'text_call_' + out.length,
      type: 'function',
      function: { name: name, arguments: JSON.stringify(args) }
    });
  }

  var reSearch = /\bweb_search\s*[:\(]\s*["'“]?([^"'\n\)]{2,200})["'”]?\s*\)?/gi;
  var m;
  while ((m = reSearch.exec(s))) {
    var q = String(m[1] || '').trim().replace(/[.,;:]+$/, '');
    if (q.length >= 2) add('web_search', { query: q });
  }

  var reBrowse = /\bbrowse_url\s*[:\(]\s*["']?(https?:\/\/[^"'\s\)]+)["']?\s*\)?/gi;
  while ((m = reBrowse.exec(s))) {
    add('browse_url', { url: m[1].trim() });
  }

  var reList = /\blist_connected_mcps\b/gi;
  if (reList.test(s) && !/list_connected_mcps\s*[:\(]/i.test(s.replace(reList, ''))) {
    // only if it looks like an invocation, not a description — skip pure docs
  }
  if (/\blist_connected_mcps\s*\(/i.test(s) || /\bcall\s+list_connected_mcps\b/i.test(s)) {
    add('list_connected_mcps', { detail: 'full' });
  }

  return out;
}

/** Remove tool-call leaks and empty “I’ll search…” stubs from user-facing text. */
function stripToolLeakage(text) {
  var s = String(text || '');
  s = s.replace(/\bweb_search\s*[:\(]\s*["'“]?[^"'\n\)]{0,200}["'”]?\s*\)?/gi, '');
  s = s.replace(/\bbrowse_url\s*[:\(]\s*["']?https?:\/\/[^"'\s\)]+["']?\s*\)?/gi, '');
  s = s.replace(/\blist_connected_mcps\s*\([^)]*\)/gi, '');
  s = s.replace(/_🔧 Using tools:[^_]*_/g, '');
  // Lone “I’ll fetch/search…” lines with no substance after
  s = s.replace(/^(?:I(?:'ll| will) (?:fetch|search|look up|pull up|browse)[^.\n]*[.!]\s*)+$/gim, '');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

/** True when the model only announced a search and never answered. */
function isToolAnnouncementOnly(text) {
  var s = String(text || '').trim();
  if (!s) return true;
  var stripped = stripToolLeakage(s);
  if (!stripped || stripped.length < 40) return true;
  if (/\bweb_search\s*[:\(]/i.test(s) && stripped.length < 120) return true;
  if (/\bI(?:'ll| will) (?:fetch|search|look up|pull up|browse)\b/i.test(s) && stripped.length < 160) return true;
  return false;
}

async function executeTool(name, args, ctx) {
  ctx = ctx || {};
  args = args && typeof args === 'object' ? args : {};
  var toolName = String(name || '').trim();

  if (toolName === 'web_search') {
    var q = String(args.query || '').trim();
    if (!q) return JSON.stringify({ ok: false, error: 'missing query' });
    var search = await duckDuckGoSearch(q);
    return formatSearchForModel(search);
  }

  if (toolName === 'browse_url') {
    var url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return JSON.stringify({ ok: false, error: 'url must start with http(s)://' });
    }
    if (!kernelLib || typeof kernelLib.tryBrowsePage !== 'function') {
      return JSON.stringify({ ok: false, error: 'browse module unavailable' });
    }
    try {
      var browsed = await kernelLib.tryBrowsePage({ url: url });
      if (!browsed || !browsed.ok) {
        return JSON.stringify({
          ok: false,
          error: (browsed && browsed.error) || 'browse failed',
          url: url
        });
      }
      return JSON.stringify({
        ok: true,
        url: url,
        source: browsed.source || 'browse',
        text: String(browsed.text || '').slice(0, 8000)
      });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  }

  if (toolName === 'list_connected_mcps') {
    var servers = ctx.mcpServers || [];
    var tools = ctx.mcpTools || [];
    var detail = String(args.detail || 'full').toLowerCase();
    if (!servers.length && !tools.length) {
      return JSON.stringify({
        ok: true,
        count: 0,
        servers: [],
        note: 'No MCP servers were attached to this request. User may have none connected.'
      });
    }
    var payload = {
      ok: true,
      count: servers.length,
      servers: servers.map(function (s) {
        return {
          name: s.name,
          url: s.url || null,
          enabled: s.enabled !== false,
          toolCount: s.toolCount || 0,
          lastError: s.lastError || null
        };
      })
    };
    if (detail !== 'summary' && tools.length) {
      payload.tools = tools.slice(0, 40).map(function (t) {
        return {
          server: t.serverName || t.serverId,
          name: t.name,
          description: t.description || ''
        };
      });
    }
    return JSON.stringify(payload);
  }

  return JSON.stringify({ ok: false, error: 'unknown tool: ' + toolName });
}

async function runToolCalls(toolCalls, ctx) {
  var list = Array.isArray(toolCalls) ? toolCalls : [];
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var tc = list[i];
    var fn = (tc && tc.function) || {};
    var name = fn.name || '';
    var rawArgs = fn.arguments || '{}';
    var parsed = {};
    try {
      parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs || {});
    } catch (_) {
      parsed = {};
    }
    var content = await executeTool(name, parsed, ctx);
    out.push({
      role: 'tool',
      tool_call_id: tc.id || ('call_' + i),
      name: name,
      content: content
    });
  }
  return out;
}

module.exports = {
  TOOL_DEFS: TOOL_DEFS,
  executeTool: executeTool,
  runToolCalls: runToolCalls,
  duckDuckGoSearch: duckDuckGoSearch,
  parseTextualToolCalls: parseTextualToolCalls,
  stripToolLeakage: stripToolLeakage,
  isToolAnnouncementOnly: isToolAnnouncementOnly
};
