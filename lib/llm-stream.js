/* lib/llm-stream.js — stream chat completions (OpenAI-compatible SSE)
 * Used by Master Agent for progressive UI and safer continuations.
 */

function looksIncomplete(text, finishReason) {
  var fr = String(finishReason || '').toLowerCase();
  if (fr === 'length' || fr === 'max_tokens' || fr === 'max_output_tokens') return true;
  var s = String(text || '').trim();
  if (!s) return false;
  // Unclosed code fence
  if (((s.match(/```/g) || []).length % 2) === 1) return true;
  // Common truncation tails
  if (/\n\s*(\.\.\.|…)\s*$/.test(s)) return true;
  if (/\b(TODO|FIXME|rest omitted|\[truncated\]|to be continued)\b/i.test(s.slice(-200))) return true;
  return false;
}

/**
 * Stream one completion. Calls onDelta(delta, fullSoFar) as tokens arrive.
 * @returns {{ text: string, finishReason: string }}
 */
async function streamOnce(url, headers, body, onDelta, timeoutMs) {
  var payload = Object.assign({}, body || {}, { stream: true });
  var controller = new AbortController();
  var timer = setTimeout(function () {
    try { controller.abort(); } catch (_) {}
  }, timeoutMs || 90000);

  var resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } finally {
    // timer cleared after read completes below
  }

  if (!resp.ok) {
    clearTimeout(timer);
    var err = new Error('HTTP ' + resp.status);
    err.status = resp.status;
    throw err;
  }

  // Fallback if provider ignored stream
  var ct = String(resp.headers.get('content-type') || '').toLowerCase();
  if (ct.indexOf('text/event-stream') === -1 && ct.indexOf('json') !== -1) {
    clearTimeout(timer);
    var data = await resp.json();
    var choice = data && data.choices && data.choices[0];
    var msg = choice && choice.message;
    var text = msg && typeof msg.content === 'string' ? msg.content : '';
    var fr = (choice && (choice.finish_reason || choice.native_finish_reason)) || '';
    if (text && onDelta) onDelta(text, text);
    return { text: text, finishReason: String(fr || '').toLowerCase() };
  }

  var reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
  if (!reader) {
    clearTimeout(timer);
    var raw = await resp.text();
    // try parse whole SSE blob
    var fullRaw = '';
    var finishRaw = '';
    raw.split('\n').forEach(function (line) {
      var t = line.trim();
      if (!t.indexOf && t.indexOf('data:') !== 0) return;
      if (t.indexOf('data:') !== 0) return;
      var d = t.slice(5).trim();
      if (d === '[DONE]') return;
      try {
        var j = JSON.parse(d);
        var delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (typeof delta === 'string' && delta) fullRaw += delta;
        var f = j.choices && j.choices[0] && j.choices[0].finish_reason;
        if (f) finishRaw = f;
      } catch (_) {}
    });
    if (fullRaw && onDelta) onDelta(fullRaw, fullRaw);
    return { text: fullRaw, finishReason: String(finishRaw || '').toLowerCase() };
  }

  var decoder = new TextDecoder();
  var buffer = '';
  var full = '';
  var finishReason = '';

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
          var deltaText = ch.delta && typeof ch.delta.content === 'string' ? ch.delta.content : '';
          if (!deltaText && ch.message && typeof ch.message.content === 'string') {
            deltaText = ch.message.content;
          }
          if (deltaText) {
            full += deltaText;
            if (onDelta) onDelta(deltaText, full);
          }
          if (ch.finish_reason) finishReason = String(ch.finish_reason).toLowerCase();
        } catch (_) {
          // ignore partial JSON lines
        }
      }
    }
  } finally {
    clearTimeout(timer);
    try { reader.releaseLock(); } catch (_) {}
  }

  return { text: full, finishReason: finishReason };
}

/** Non-stream single shot (for continuations / providers that break on stream). */
async function completeOnce(url, headers, body, timeoutMs) {
  var payload = Object.assign({}, body || {}, { stream: false });
  var resp = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs || 90000)
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
  return { text: text, finishReason: String(finishReason || '').toLowerCase() };
}

module.exports = {
  streamOnce: streamOnce,
  completeOnce: completeOnce,
  looksIncomplete: looksIncomplete
};
