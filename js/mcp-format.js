/* mcp-format.js — Human-readable MCP results (CoinGecko price cards, etc.)
 * Loaded after master-client.js. Patches MasterChat.formatMcpResult if exposed,
 * and provides global MCPFormat.humanize for Execute handlers.
 */
(function (global) {
  'use strict';

  function formatUsd(n) {
    if (n == null || isNaN(Number(n))) return '\u2014';
    var v = Number(n);
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (v >= 1) return '$' + v.toLocaleString(undefined, { maximumFractionDigits: 4 });
    if (v >= 0.01) return '$' + v.toFixed(4);
    return '$' + v.toPrecision(4);
  }

  function formatPct(n) {
    if (n == null || isNaN(Number(n))) return '\u2014';
    var v = Number(n);
    var sign = v > 0 ? '+' : '';
    return sign + v.toFixed(2) + '%';
  }

  function titleCaseId(id) {
    return String(id || '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function humanizeCoinGeckoPayload(data) {
    if (!data || typeof data !== 'object') return null;

    var id = data.id || data.coin_id || data.coinId || null;
    var query = data.query || data.name || null;
    var priceRoot = data.price || data.prices || data.data || data;

    if (priceRoot && typeof priceRoot === 'object' && !Array.isArray(priceRoot)) {
      var keys = Object.keys(priceRoot);
      if (keys.length === 1 && typeof priceRoot[keys[0]] === 'object' && priceRoot[keys[0]] !== null) {
        if (!id) id = keys[0];
        priceRoot = priceRoot[keys[0]];
      } else if (id && typeof priceRoot[id] === 'object') {
        priceRoot = priceRoot[id];
      }
    }

    if (!priceRoot || typeof priceRoot !== 'object') return null;

    var usd = priceRoot.usd != null ? priceRoot.usd
      : priceRoot.price != null ? priceRoot.price
      : priceRoot.current_price != null ? priceRoot.current_price
      : null;
    var change = priceRoot.usd_24h_change != null ? priceRoot.usd_24h_change
      : priceRoot.price_change_percentage_24h != null ? priceRoot.price_change_percentage_24h
      : priceRoot.change_24h != null ? priceRoot.change_24h
      : null;
    var mcap = priceRoot.usd_market_cap != null ? priceRoot.usd_market_cap
      : priceRoot.market_cap != null ? priceRoot.market_cap
      : null;

    if (usd == null && change == null && mcap == null) return null;

    var title = query || titleCaseId(id) || 'Asset';
    if (id && query && String(query).toLowerCase() !== String(id).toLowerCase()) {
      title = query + ' (' + id + ')';
    } else if (id && !query) {
      title = titleCaseId(id) + ' (' + id + ')';
    }

    return [
      '**' + title + '**',
      '',
      '- **Price:** ' + formatUsd(usd) + ' USD',
      '- **24h change:** ' + formatPct(change),
      '- **Market cap:** ' + formatUsd(mcap),
      '',
      '_Source: CoinGecko via MCP_'
    ].join('\n');
  }

  function tryParseJsonString(s) {
    if (typeof s !== 'string') return null;
    var t = s.trim();
    if (!(t.charAt(0) === '{' || t.charAt(0) === '[')) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  function formatMcpResult(result) {
    if (result == null) return '(empty result)';

    var payload = result;
    if (result.structuredContent) payload = result.structuredContent;

    if (result.content && Array.isArray(result.content)) {
      var parts = [];
      result.content.forEach(function (c) {
        if (c && c.type === 'text' && c.text) {
          var parsed = tryParseJsonString(c.text);
          if (parsed) {
            var card = humanizeCoinGeckoPayload(parsed);
            parts.push(card || c.text);
          } else {
            parts.push(c.text);
          }
        } else if (c && c.type === 'resource' && c.resource) {
          var card2 = humanizeCoinGeckoPayload(c.resource);
          parts.push(card2 || JSON.stringify(c.resource, null, 2));
        } else if (c) {
          var card3 = humanizeCoinGeckoPayload(c);
          parts.push(card3 || JSON.stringify(c));
        }
      });
      return parts.join('\n\n') || '(empty result)';
    }

    if (typeof payload === 'string') {
      var p = tryParseJsonString(payload);
      if (p) {
        var cardS = humanizeCoinGeckoPayload(p);
        if (cardS) return cardS;
      }
      return payload;
    }

    var card = humanizeCoinGeckoPayload(payload);
    if (card) return card;

    try {
      return '_MCP result_\n\n```json\n' + JSON.stringify(payload, null, 2).slice(0, 4000) + '\n```';
    } catch (e) {
      return String(payload);
    }
  }

  global.MCPFormat = {
    humanizeCoinGeckoPayload: humanizeCoinGeckoPayload,
    formatMcpResult: formatMcpResult,
    formatUsd: formatUsd,
    formatPct: formatPct
  };
})(window);
