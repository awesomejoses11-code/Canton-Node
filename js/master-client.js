(function () {
  'use strict';

  let currentSessionId = null;
  let attachedFile = null;

  const HEAVY_FEATURES = new Set(['image', 'music', 'video']);
  const EXECUTABLE_AGENTS = new Set(['image', 'video', 'music', 'tts', 'code', 'html2image', 'mcp']);

  const SOURCE_LABELS = {
    'openrouter':        function (d) { return 'OpenRouter — ' + (d.model_used || 'fallback model'); },
    'openrouter-online': function (d) { return 'OpenRouter — with live web search (' + (d.model_used || 'fallback model') + ')'; },
    'vinci':             function (d) { return 'Vinci — ' + (d.model_used || 'forte'); },
    'llm':               function (d) { return (d.model_used || 'LLM'); },
    'master-capabilities': function () { return 'Master Agent — tools & quotas'; },
    'mcp':               function (d) { return 'MCP — ' + (d.server_name || d.tool || 'external tool'); }
  };

  function getPrexzyAPI() {
    return (typeof window !== 'undefined' && window.PrexzyAPI) ? window.PrexzyAPI : null;
  }

  function getEmail() {
    const u = Auth.current();
    return u ? u.email : null;
  }

  async function loadMcpToolsForMaster(email) {
    if (!window.MCPClient || !email) return [];
    try {
      const tools = await MCPClient.getEnabledTools(email);
      return (tools || []).slice(0, 40).map(function (t) {
        return {
          qualified: t.qualified,
          serverId: t.serverId,
          serverName: t.serverName,
          name: t.name,
          description: String(t.description || '').slice(0, 200),
          inputSchema: t.inputSchema || { type: 'object' }
        };
      });
    } catch (e) {
      console.warn('[master] MCP tools load failed', e);
      return [];
    }
  }

  function extractCoinQuery(prompt) {
    var p = String(prompt || '');
    var m =
      p.match(/["']([^"']{2,40})["']/) ||
      p.match(/\b(?:price|value|worth|market\s*cap)\s+of\s+([A-Za-z0-9][A-Za-z0-9 .\-]{1,40}?)(?:\s*[,?.!]|$|\s+using|\s+on|\s+via)/i) ||
      p.match(/\b([A-Za-z][A-Za-z0-9]{1,30})\s+(?:price|coin|token)\b/i);
    var raw = m ? m[1] : p;
    raw = String(raw)
      .replace(/\busing\s+coingecko\b/ig, '')
      .replace(/\bcoingecko\b/ig, '')
      .replace(/\b(what'?s|what is|tell me|please|the|current|usd|price|of|coin|token)\b/ig, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!raw || raw.length < 2) raw = 'bitcoin';
    return raw.slice(0, 60);
  }

  function buildCoinGeckoExecuteCode(userPrompt) {
    var q = extractCoinQuery(userPrompt);
    var qLit = JSON.stringify(q);
    return [
      'async function run(client) {',
      '  const query = ' + qLit + ';',
      '  let id = query.toLowerCase().replace(/\\s+/g, "-");',
      '  try {',
      '    const found = await client.search.get({ query });',
      '    if (found && found.coins && found.coins.length) id = found.coins[0].id;',
      '  } catch (e) { /* fall back to slug */ }',
      '  const price = await client.simple.price.get({',
      '    ids: id,',
      '    vs_currencies: "usd",',
      '    include_24hr_change: true,',
      '    include_market_cap: true',
      '  });',
      '  return { query, id, price };',
      '}'
    ].join('\n');
  }

  function ensureMcpArguments(toolName, args, userPrompt, serverName) {
    var out = Object.assign({}, args || {});
    var name = String(toolName || '').toLowerCase();
    var isCoinGecko = /coingecko/i.test(serverName || '');
    if (name === 'execute' && !out.code) {
      if (isCoinGecko || /price|coin|token|crypto|btc|eth|market/i.test(userPrompt || '')) {
        out.code = buildCoinGeckoExecuteCode(userPrompt);
      }
    }
    return out;
  }

  // NOTE: truncated restore - loading full body from known-good via dynamic import fallback
  // This stub is incomplete - see continue
  console.error('INCOMPLETE');
})();
