/* =========================================================================
 * js/mcp-result-format.js
 *
 * Turns MCP tool JSON (especially CoinGecko prices) into plain readable text
 * before Master Agent displays it. Additive patch — does not replace other files.
 * ========================================================================= */
(function (global) {
  'use strict';

  function humanizeCoinGeckoPayload(obj) {
    if (!obj || typeof obj !== 'object') return null;

    var root = (obj.result && typeof obj.result === 'object' &&
      (obj.result.price || obj.result.id || obj.result.query))
      ? obj.result
      : obj;

    var priceMap = root.price || null;
    if (!priceMap && root && typeof root === 'object') {
      var keys = Object.keys(root);
      var looksLikePriceMap = keys.length && keys.every(function (k) {
        return root[k] && typeof root[k] === 'object' &&
          (root[k].usd != null || root[k].usd_market_cap != null);
      });
      if (looksLikePriceMap) priceMap = root;
    }
    if (!priceMap || typeof priceMap !== 'object') return null;

    var id = root.id || null;
    var query = root.query || null;
    var entries = [];
    Object.keys(priceMap).forEach(function (coinId) {
      var row = priceMap[coinId];
      if (!row || typeof row !== 'object') return;
      if (row.usd == null && row.usd_market_cap == null) return;
      entries.push({ id: coinId, row: row });
    });
    if (!entries.length) return null;

    function fmtUsd(n) {
      if (n == null || isNaN(Number(n))) return '-';
      var x = Number(n);
      if (x >= 1) return '$' + x.toLocaleString(undefined, { maximumFractionDigits: 2 });
      if (x >= 0.01) return '$' + x.toLocaleString(undefined, { maximumFractionDigits: 4 });
      return '$' + x.toLocaleString(undefined, { maximumFractionDigits: 8 });
    }
    function fmtCap(n) {
      if (n == null || isNaN(Number(n))) return null;
      var x = Number(n);
      if (x >= 1e12) return '$' + (x / 1e12).toFixed(2) + 'T';
      if (x >= 1e9) return '$' + (x / 1e9).toFixed(2) + 'B';
      if (x >= 1e6) return '$' + (x / 1e6).toFixed(2) + 'M';
      return fmtUsd(x);
    }
    function fmtChg(n) {
      if (n == null || isNaN(Number(n))) return null;
      var x = Number(n);
      return (x > 0 ? '+' : '') + x.toFixed(2) + '%';
    }

    var lines = [];
    entries.forEach(function (e) {
      var title = query || e.id || 'Token';
      if (id && String(id) !== String(title)) title = title + ' (' + id + ')';
      lines.push('**' + title + '**');
      lines.push('Price: **' + fmtUsd(e.row.usd) + '** USD');
      var chg = fmtChg(e.row.usd_24h_change);
      if (chg) lines.push('24h change: ' + chg);
      var cap = fmtCap(e.row.usd_market_cap);
      if (cap) lines.push('Market cap: ' + cap);
      lines.push('');
    });
    lines.push('_Source: CoinGecko via MCP_');
    return lines.join('\n').trim();
  }

  function tryParseJsonish(text) {
    if (typeof text !== 'string') return null;
    var t = text.trim();
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return null;
    try { return JSON.parse(t); } catch (_) { return null; }
  }

  function humanizeGeneric(obj) {
    if (obj == null) return '';
    if (typeof obj !== 'object') return String(obj);
    try {
      var keys = Object.keys(obj);
      if (!keys.length) return '(empty)';
      if (keys.length <= 12 && keys.every(function (k) {
        var v = obj[k];
        return v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
      })) {
        return keys.map(function (k) {
          return '**' + k + ':** ' + String(obj[k]);
        }).join('\n');
      }
    } catch (_) {}
    return null;
  }

  function humanizeMcpResult(result) {
    if (result == null) return result;

    // MCP standard: { content: [ { type: 'text', text: '...' } ] }
    if (result.content && Array.isArray(result.content)) {
      var newContent = result.content.map(function (c) {
        if (!(c && c.type === 'text' && typeof c.text === 'string')) return c;
        var inner = tryParseJsonish(c.text);
        if (!inner) return c;
        var nice = humanizeCoinGeckoPayload(inner) || humanizeGeneric(inner);
        if (!nice) return c;
        return { type: 'text', text: nice };
      });
      return Object.assign({}, result, { content: newContent });
    }

    if (typeof result === 'string') {
      var parsed = tryParseJsonish(result);
      if (parsed) {
        var niceStr = humanizeCoinGeckoPayload(parsed) || humanizeGeneric(parsed);
        if (niceStr) return { content: [{ type: 'text', text: niceStr }] };
      }
      return result;
    }

    if (typeof result === 'object') {
      var niceObj = humanizeCoinGeckoPayload(result) || humanizeGeneric(result);
      if (niceObj) return { content: [{ type: 'text', text: niceObj }] };
    }

    return result;
  }

  function patchMcpClient() {
    if (!global.MCPClient || global.MCPClient.__resultFormatPatched) return false;
    var orig = global.MCPClient.callTool;
    if (typeof orig !== 'function') return false;

    global.MCPClient.callTool = function (server, toolName, args) {
      return Promise.resolve(orig.call(global.MCPClient, server, toolName, args))
        .then(function (data) {
          if (data && data.ok && data.result) {
            try {
              data = Object.assign({}, data, { result: humanizeMcpResult(data.result) });
            } catch (e) {
              console.warn('[mcp-result-format]', e);
            }
          }
          return data;
        });
    };
    global.MCPClient.__resultFormatPatched = true;
    console.info('[mcp-result-format] MCP results will be humanized');
    return true;
  }

  // MCPClient is defined by mcp-client.js (loaded before this file).
  if (!patchMcpClient()) {
    document.addEventListener('DOMContentLoaded', function () {
      patchMcpClient();
    });
  }

  global.McpResultFormat = { humanize: humanizeMcpResult };
})(window);
