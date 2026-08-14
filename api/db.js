/* =========================================================================
 * api/db.js — Neon Postgres helper (Vercel DATABASE_URL)
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
  /* Per-user markdown memory docs (reference.md + user_logs.md) — cross-device */
  await sql`
    CREATE TABLE IF NOT EXISTS user_docs (
      email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
      doc_key TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (email, doc_key)
    )
  `;
  schemaReady = true;
  return true;
}

module.exports = {
  getSql: getSql,
  ensureSchema: ensureSchema,
  hasDatabase: function () {
    return !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  }
};
