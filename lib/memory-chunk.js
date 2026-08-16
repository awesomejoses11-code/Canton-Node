/* =========================================================================
 * lib/memory-chunk.js — Markdown-aware chunking for agent memory
 * ========================================================================= */

var TARGET = 500;
var OVERLAP = 80;

function estimateTokens(s) {
  return Math.ceil(String(s || '').length / 4);
}

function chunkMarkdown(text) {
  var raw = String(text || '').trim();
  if (!raw) return [];

  var blocks = raw.split(/\n(?=#{1,3}\s)|\n{2,}/);
  var pieces = [];
  var buf = '';

  function flush() {
    var t = buf.trim();
    if (t) pieces.push(t);
    buf = '';
  }

  for (var i = 0; i < blocks.length; i++) {
    var b = String(blocks[i] || '').trim();
    if (!b) continue;
    if (!buf) {
      buf = b;
    } else if (buf.length + b.length + 2 <= TARGET) {
      buf = buf + '\n\n' + b;
    } else {
      flush();
      if (pieces.length) {
        var prev = pieces[pieces.length - 1];
        var tail = prev.slice(Math.max(0, prev.length - OVERLAP));
        buf = tail + '\n\n' + b;
      } else {
        buf = b;
      }
    }
  }
  flush();

  var out = [];
  for (var j = 0; j < pieces.length; j++) {
    var p = pieces[j];
    if (p.length <= TARGET * 1.5) {
      out.push(p);
      continue;
    }
    for (var k = 0; k < p.length; k += TARGET - OVERLAP) {
      var slice = p.slice(k, k + TARGET).trim();
      if (slice) out.push(slice);
    }
  }
  return out;
}

module.exports = { chunkMarkdown: chunkMarkdown, estimateTokens: estimateTokens };
