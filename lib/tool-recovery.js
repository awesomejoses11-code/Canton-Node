/* lib/tool-recovery.js — if the model only announced web_search in text, force search + second pass */
var masterTools = null;
try { masterTools = require('./master-tools'); } catch (_) { masterTools = null; }

function needsRecovery(text) {
  if (!masterTools) return false;
  if (masterTools.isToolAnnouncementOnly && masterTools.isToolAnnouncementOnly(text)) return true;
  var s = String(text || '');
  if (/\bweb_search\s*[:\(]/i.test(s)) return true;
  if (/\bI(?:'ll| will) (?:fetch|search|look up|pull up)\b/i.test(s) && s.length < 500) return true;
  return false;
}

function clean(text) {
  if (masterTools && masterTools.stripToolLeakage) return masterTools.stripToolLeakage(text);
  return String(text || '').trim();
}

/**
 * If answer is tool-narration only, run web_search and ask tryGenerateAnswer once more with results injected.
 */
async function recoverIfNeeded(message, history, prefs, memory, opts, tryGenerateAnswer, previous) {
  opts = opts || {};
  var text = previous && previous.text ? previous.text : '';
  if (!needsRecovery(text)) {
    if (previous) previous.text = clean(text);
    return previous;
  }
  if (!masterTools || !masterTools.duckDuckGoSearch) {
    if (previous) previous.text = clean(text) || text;
    return previous;
  }

  var query = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  var parsed = masterTools.parseTextualToolCalls ? masterTools.parseTextualToolCalls(text) : [];
  if (parsed.length && parsed[0].function && parsed[0].function.arguments) {
    try {
      var args = JSON.parse(parsed[0].function.arguments);
      if (args.query) query = String(args.query).slice(0, 180);
    } catch (_) {}
  }

  var search = await masterTools.duckDuckGoSearch(query);
  var note = '';
  if (search && search.ok && search.results && search.results.length) {
    note = search.results.map(function (r, i) {
      return (i + 1) + '. **' + r.title + '**\n   ' + r.url;
    }).join('\n');
  }

  var enriched =
    String(message || '') +
    '\n\n---\nLive web search results for "' + query + '":\n' +
    (note || '(no hits — answer from reliable knowledge; do not invent URLs)') +
    '\n---\nWrite a complete Markdown answer for the user. Cite links. Do NOT write web_search or say you will search.';

  var second = await tryGenerateAnswer(enriched, history, prefs, memory, {
    web: false,
    code: opts.code,
    edit: opts.edit,
    mcpServers: opts.mcpServers,
    mcpTools: opts.mcpTools,
    onDelta: opts.onDelta
  });

  if (second && second.text) {
    second.text = clean(second.text);
    second.tools_used = (previous.tools_used || 0) + 1;
    second.web = true;
    second.model = (second.model || '') + ' · recovered';
    return second;
  }

  if (previous) previous.text = clean(text) || text;
  return previous;
}

module.exports = {
  needsRecovery: needsRecovery,
  recoverIfNeeded: recoverIfNeeded,
  clean: clean
};
