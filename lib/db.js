/* =========================================================================
 * lib/db.js — Neon Postgres helper (Vercel DATABASE_URL)
 * ========================================================================= */

var neonSql = null;
var schemaReady = false;

function getSql() {
  if (neonSql) return neonSql;
  var url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return null;
  try {
    var neon = require('@neondatabase/serverless').neon;
    neonSql = neon(url);
    return neonSql;
  } catch (err) {
    console.error('[db] neon load failed', err && err.message);
    return null;
  }
}

async function ensureSchema() {
  if (schemaReady) return true;
  var sql = getSql();
  if (!sql) return false;

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS user_docs (
      email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
      doc_key TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (email, doc_key)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS chat_history (
      email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
      sessions JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;

  // pgvector memory chunks (best-effort; schema still works if extension missing)
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await sql`
      CREATE TABLE IF NOT EXISTS memory_chunks (
        id            BIGSERIAL PRIMARY KEY,
        email         TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
        source        TEXT NOT NULL,
        chunk_index   INT  NOT NULL,
        content       TEXT NOT NULL,
        token_est     INT  NOT NULL DEFAULT 0,
        embedding     vector(384),
        content_hash  TEXT NOT NULL,
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (email, source, chunk_index)
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS memory_chunks_email_source_idx
      ON memory_chunks (email, source)
    `;
    try {
      await sql`
        CREATE INDEX IF NOT EXISTS memory_chunks_embedding_hnsw
        ON memory_chunks
        USING hnsw (embedding vector_cosine_ops)
      `;
    } catch (idxErr) {
      console.warn('[db] hnsw index skip', idxErr && idxErr.message);
    }
  } catch (vecErr) {
    console.error('[db] pgvector setup skipped', vecErr && vecErr.message);
  }

  schemaReady = true;
  return true;
}

async function resolveEmailFromToken(token) {
  if (!token) return null;
  var sql = getSql();
  if (!sql) return null;
  try {
    await ensureSchema();
    var rows = await sql`
      SELECT s.email, s.expires_at FROM sessions s WHERE s.token = ${token} LIMIT 1
    `;
    if (!rows || !rows.length) return null;
    if (new Date(rows[0].expires_at).getTime() < Date.now()) {
      await sql`DELETE FROM sessions WHERE token = ${token}`;
      return null;
    }
    return rows[0].email;
  } catch (e) {
    console.error('[db] resolveEmailFromToken', e && e.message);
    return null;
  }
}

module.exports = {
  getSql: getSql,
  ensureSchema: ensureSchema,
  resolveEmailFromToken: resolveEmailFromToken,
  hasDatabase: function () {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  }
};
