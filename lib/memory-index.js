/* =========================================================================
 * lib/memory-index.js — chunk + embed + pgvector retrieve for agent memory
 * ========================================================================= */

var crypto = require('crypto');
var db = require('./db');
var chunker = require('./memory-chunk');
var embed = require('./embed');

function hash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
}

async function reindexSource(email, source, fullText) {
  var sql = db.getSql();
  if (!sql) return { ok: false, error: 'no_db' };
  if (!email || !source) return { ok: false, error: 'missing email/source' };

  await db.ensureSchema();

  var chunks = chunker.chunkMarkdown(fullText);
  if (!chunks.length) {
    await sql`DELETE FROM memory_chunks WHERE email = ${email} AND source = ${source}`;
    return { ok: true, count: 0 };
  }

  if (chunks.length > 40) chunks = chunks.slice(0, 40);

  var vectors;
  try {
    vectors = await embed.embedTexts(chunks);
  } catch (e) {
    console.error('[memory-index] embed failed', e && e.message);
    return { ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) };
  }

  await sql`DELETE FROM memory_chunks WHERE email = ${email} AND source = ${source}`;

  var inserted = 0;
  for (var i = 0; i < chunks.length; i++) {
    var content = chunks[i];
    var vec = embed.toPgVector(vectors[i]);
    if (!vec) continue;
    try {
      await sql`
        INSERT INTO memory_chunks
          (email, source, chunk_index, content, token_est, embedding, content_hash, updated_at)
        VALUES
          (${email}, ${source}, ${i}, ${content}, ${chunker.estimateTokens(content)},
           ${vec}::vector, ${hash(content)}, NOW())
      `;
      inserted++;
    } catch (insErr) {
      console.error('[memory-index] insert chunk', i, insErr && insErr.message);
    }
  }
  return { ok: true, count: inserted };
}

async function retrieve(email, query, opts) {
  opts = opts || {};
  var k = opts.k || 6;
  var maxChars = opts.maxChars || 6000;
  var sources = opts.sources || ['reference', 'user_logs'];
  var maxDistance = typeof opts.maxDistance === 'number' ? opts.maxDistance : 0.92;

  var sql = db.getSql();
  if (!sql || !email || !query) return [];

  await db.ensureSchema();

  var qVec;
  try {
    qVec = embed.toPgVector((await embed.embedTexts([String(query).slice(0, 2000)]))[0]);
  } catch (e) {
    console.error('[memory-index] query embed failed', e && e.message);
    return [];
  }
  if (!qVec) return [];

  var rows;
  try {
    rows = await sql`
      SELECT source, content, chunk_index,
             (embedding <=> ${qVec}::vector) AS distance
      FROM memory_chunks
      WHERE email = ${email}
        AND source = ANY(${sources})
      ORDER BY embedding <=> ${qVec}::vector
      LIMIT ${k}
    `;
  } catch (e) {
    console.error('[memory-index] retrieve failed', e && e.message);
    return [];
  }

  var out = [];
  var used = 0;
  for (var i = 0; i < (rows || []).length; i++) {
    var r = rows[i];
    var dist = r.distance != null ? Number(r.distance) : 99;
    if (dist > maxDistance) continue;
    var c = String(r.content || '');
    if (!c) continue;
    if (used + c.length > maxChars) {
      var room = maxChars - used;
      if (room < 120) break;
      c = c.slice(0, room);
    }
    out.push({ source: r.source, content: c, distance: dist, chunk_index: r.chunk_index });
    used += c.length;
  }
  return out;
}

function formatForPrompt(chunks) {
  if (!chunks || !chunks.length) return '';
  return chunks.map(function (c, i) {
    return '[' + (i + 1) + ' · ' + c.source + ']\n' + c.content;
  }).join('\n\n');
}

async function enrichMemory(email, query, memory) {
  var base = memory && typeof memory === 'object' ? memory : null;
  if (!base || base.enabled === false) return base;
  if (!email || !query) return base;

  try {
    var hits = await retrieve(email, query, { k: 6, maxChars: 6000 });
    if (hits && hits.length) {
      return {
        enabled: true,
        reference: formatForPrompt(hits),
        user_logs: '',
        retrieved: true,
        hit_count: hits.length
      };
    }
  } catch (e) {
    console.error('[memory-index] enrich failed', e && e.message);
  }
  return base;
}

module.exports = {
  reindexSource: reindexSource,
  retrieve: retrieve,
  formatForPrompt: formatForPrompt,
  enrichMemory: enrichMemory
};
