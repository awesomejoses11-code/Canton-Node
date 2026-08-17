/* lib/llm-stream.js — stream chat completions (OpenAI-compatible SSE)
 * Supports GLM-5.2 tool_stream: incremental tool_calls + reasoning_content.
 */

function looksIncomplete(text, finishReason) {
  var fr = String(finishReason || '').toLowerCase();
  if (fr === 'length' || fr === 'max_tokens' || fr === 'max_output_tokens') return true;
  var s = String(text || '').trim();
  if (!s) return false;
  if (((s.match(/```/g) || []).length % 2) === 1) return true;
  if (/\n\s*(\.\.\.|…)\s*$/.test(s)) return true;
  if (/\b(TODO|FIXME|rest omitted|\[truncated\]|to be continued)\b/i.test(s.slice(-200))) return true;
  return false;
}

function ensureToolSlot(map, index, partial) {
  if (!map[index]) {
    map[index] = {
      id: (partial && partial.id) || '',
      type: 'function',
      function: { name: '', arguments: '' }
    };
  }
  var slot = map[index];
  if (partial) {
    if (partial.id) slot.id = partial.id;
    if (partial.type) slot.type = partial.type;
    if (partial.function) {
      if (partial.function.name) slot.function.name = partial.function.name;
      if (typeof partial.function.arguments === 'string') {
        slot.function.arguments += partial.function.arguments;
      }
    }
  }
  return slot;
}

function toolMapToArray(map) {
  return Object.keys(map)
    .map(function (k) { return Number(k); })
    .sort(function (a, b) { return a - b; })
    .map(function (k) {
      var t = map[k];
      if (!t.id) t.id = 'call_' + k;
      return t;
    })
    .filter(function (t) { return t.function && t.function.name; });
}

/**
 * Stream one completion.
 * onDelta(deltaText, fullSoFar, meta) — meta may include reasoningDelta / toolProgress
 * @returns {{ text, finishReason, toolCalls, reasoning }}
 */
async function streamOnce(url, headers, body, onDelta, timeoutMs) {
  var payload = Object.assign({}, body || {}, { stream: true });
  var controller = new AbortController();
  var timer = setTimeout(function () {
    try { controller.abort(); } catch (_) {}
  }, timeoutMs || 120000);

  var resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }

  if (!resp.ok) {
    clearTimeout(timer);
    var err = new Error('HTTP ' + resp.status);
    err.status = resp.status;
    throw err;
  }

  var ct = String(resp.headers.get('content-type') || '').toLowerCase();
  if (ct.indexOf('text/event-stream') === -1 && ct.indexOf('json') !== -1) {
    clearTimeout(timer);
    var data = await resp.json();
    var choice = data && data.choices && data.choices[0];
    var msg = choice && choice.message;
    var text = msg && typeof msg.content === 'string' ? msg.content : '';
    var fr = (choice && (choice.finish_reason || choice.native_finish_reason)) || '';
    var toolCalls = (msg && Array.isArray(msg.tool_calls)) ? msg.tool_calls : [];
    var reasoning = (msg && (msg.reasoning_content || msg.reasoning)) || '';
    if (text && onDelta) onDelta(text, text, { reasoning: reasoning });
    return {
      text: text,
      finishReason: String(fr || '').toLowerCase(),
      toolCalls: toolCalls,
      reasoning: String(reasoning || '')
    };
  }

  var reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
  if (!reader) {
    clearTimeout(timer);
    var raw = await resp.text();
    var fullRaw = '';
    var finishRaw = '';
    var toolMapRaw = {};
    var reasoningRaw = '';
    raw.split('\n').forEach(function (line) {
      var t = line.trim();
      if (t.indexOf('data:') !== 0) return;
      var d = t.slice(5).trim();
      if (d === '[DONE]') return;
      try {
        var j = JSON.parse(d);
        var ch0 = j.choices && j.choices[0];
        if (!ch0) return;
        var delta = ch0.delta || {};
        if (typeof delta.content === 'string' && delta.content) fullRaw += delta.content;
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          reasoningRaw += delta.reasoning_content;
        }
        if (Array.isArray(delta.tool_calls)) {
          delta.tool_calls.forEach(function (tc) {
            ensureToolSlot(toolMapRaw, typeof tc.index === 'number' ? tc.index : 0, tc);
          });
        }
        if (ch0.finish_reason) finishRaw = ch0.finish_reason;
      } catch (_) {}
    });
    if (fullRaw && onDelta) onDelta(fullRaw, fullRaw, {});
    return {
      text: fullRaw,
      finishReason: String(finishRaw || '').toLowerCase(),
      toolCalls: toolMapToArray(toolMapRaw),
      reasoning: reasoningRaw
    };
  }

  var decoder = new TextDecoder();
  var buffer = '';
  var full = '';
  var finishReason = '';
  var toolMap = {};
  var reasoning = '';

  try {
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line.charAt(0) === ':') continue;
        if (line.indexOf('data:') !== 0) continue;
        var dataStr = line.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') continue;
        try {
          var json = JSON.parse(dataStr);
          var ch = json.choices && json.choices[0];
          if (!ch) continue;
          var dlt = ch.delta || {};

          var deltaText = typeof dlt.content === 'string' ? dlt.content : '';
          if (!deltaText && ch.message && typeof ch.message.content === 'string') {
            deltaText = ch.message.content;
          }
          if (deltaText) {
            full += deltaText;
            if (onDelta) onDelta(deltaText, full, {});
          }

          if (typeof dlt.reasoning_content === 'string' && dlt.reasoning_content) {
            reasoning += dlt.reasoning_content;
            if (onDelta) onDelta('', full, { reasoningDelta: dlt.reasoning_content });
          }

          if (Array.isArray(dlt.tool_calls)) {
            dlt.tool_calls.forEach(function (tc) {
              var idx = typeof tc.index === 'number' ? tc.index : 0;
              ensureToolSlot(toolMap, idx, tc);
            });
            if (onDelta) onDelta('', full, { toolProgress: true });
          }

          if (ch.finish_reason) finishReason = String(ch.finish_reason).toLowerCase();
        } catch (_) {}
      }
    }
  } finally {
    clearTimeout(timer);
    try { reader.releaseLock(); } catch (_) {}
  }

  return {
    text: full,
    finishReason: finishReason,
    toolCalls: toolMapToArray(toolMap),
    reasoning: reasoning
  };
}

/** Non-stream single shot (also returns tool_calls when present). */
async function completeOnce(url, headers, body, timeoutMs) {
  var payload = Object.assign({}, body || {}, { stream: false });
  var resp = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs || 120000)
  });
  if (!resp.ok) {
    var err = new Error('HTTP ' + resp.status);
    err.status = resp.status;
    throw err;
  }
  var data = await resp.json();
  var choice = data && data.choices && data.choices[0];
  var msg = choice && choice.message;
  var text = msg && typeof msg.content === 'string' ? msg.content.trim() : '';
  var finishReason = (choice && (choice.finish_reason || choice.native_finish_reason)) || '';
  var toolCalls = (msg && Array.isArray(msg.tool_calls)) ? msg.tool_calls : [];
  var reasoning = (msg && (msg.reasoning_content || msg.reasoning)) || '';
  return {
    text: text,
    finishReason: String(finishReason || '').toLowerCase(),
    toolCalls: toolCalls,
    reasoning: String(reasoning || '')
  };
}

module.exports = {
  streamOnce: streamOnce,
  completeOnce: completeOnce,
  looksIncomplete: looksIncomplete
};
