// PostgreSQL adapter — implements the same sync-API shape as the SQLite
// adapters, but over the network. Requires DATABASE_URL (or SUPABASE_DB_URL).
//
// ponytail: This adapter exposes async methods, so callers in the db tree must
// `await` every db.get/all/run/exec and use `await db.transaction(async () => {})`.
// The SQLite adapters are synchronous; the two are NOT drop-in interchangeable.
// If a non-async call site creeps in, it silently gets a Promise — do not ship
// that. The `?`→`$n` rebind below keeps all repo SQL written in SQLite style.
import pg from "pg";
import { TABLES } from "../schema.js";

const state = global._pgAdapterState || { pool: null };
if (!global._pgAdapterState) global._pgAdapterState = state;

// Postgres folds unquoted identifiers to lowercase, so SELECT * returns columns
// like `isactive`/`createdat`, but the app reads camelCase (`isActive`). Map
// every schema column back to its declared camelCase name; unknown keys
// (e.g. `COUNT(*) AS n`, single-word cols) pass through untouched.
const COL_MAP = {};
for (const def of Object.values(TABLES)) {
  for (const col of Object.keys(def.columns)) COL_MAP[col.toLowerCase()] = col;
}
function rekey(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[COL_MAP[k] || k] = v;
  return out;
}

function connectionUrl() {
  return process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
}

function ensurePool() {
  if (state.pool) return state.pool;
  const url = connectionUrl();
  if (!url) throw new Error("[DB][pg] No DATABASE_URL / SUPABASE_DB_URL set");
  const pool = new pg.Pool({ connectionString: url });
  pool.on("error", (e) => console.error("[DB][pg] idle client error:", e.message));
  state.pool = pool;
  return pool;
}

// Rewrite SQLite `?` placeholders to Postgres `$1,$2,…`, skipping `'…'`,
// `"…"` and `$$…$$` string bodies so a literal `?` inside a value is untouched.
function rebind(sql) {
  let out = "";
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      out += ch; i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === "'" && sql[i + 1] === "'") { out += sql[i + 1]; i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '"') {
      out += ch; i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === "$" && sql[i + 1] === "$") {
      const end = sql.indexOf("$$", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "?") { n++; out += "$" + n; i++; continue; }
    out += ch; i++;
  }
  return out;
}

export async function createPgAdapter() {
  const pool = ensurePool();
  await pool.query("SELECT 1"); // fail fast if unreachable / bad creds
  let tx = null;

  async function runSql(sql, params) {
    const client = tx || pool;
    // undefined/null params → simple protocol (allows multi-statement), used by exec()
    const result =
      params === undefined || params === null
        ? await client.query(sql)
        : await client.query(sql, params);
    return result;
  }

  return {
    driver: "postgres",
    async run(sql, params = []) {
      const r = await runSql(rebind(sql), params);
      return { changes: r.rowCount ?? 0, lastInsertRowid: 0 };
    },
    async get(sql, params = []) {
      const r = await runSql(rebind(sql), params);
      return rekey(r.rows[0]);
    },
    async all(sql, params = []) {
      const r = await runSql(rebind(sql), params);
      return r.rows.map(rekey);
    },
    async exec(sql) {
      await runSql(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      const prev = tx;
      tx = client;
      try {
        await client.query("BEGIN");
        await fn(); // fn must be async and `await` its db calls
        await client.query("COMMIT");
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch {}
        throw e;
      } finally {
        tx = prev;
        client.release();
      }
    },
    async checkpoint() {}, // no WAL to checkpoint on Postgres
    async close() {
      await pool.end();
      state.pool = null;
    },
    raw: pool,
  };
}
