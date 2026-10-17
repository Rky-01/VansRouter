// Import a 9router backup JSON (exportDb format) into a Postgres/Supabase DB.
// Usage: DATABASE_URL="postgresql://..." node scripts/import-backup-to-pg.cjs <backup.json>
// Mirrors src/lib/db/index.js importDb() exactly (wipe tables, re-insert, bump revision).
const fs = require("fs");
const path = require("path");

const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
if (!url) {
  console.error("Set DATABASE_URL (or SUPABASE_DB_URL) first.");
  process.exit(1);
}
const jsonPath = process.argv[2];
if (!jsonPath) {
  console.error("Usage: DATABASE_URL=... node import-backup-to-pg.cjs <backup.json>");
  process.exit(1);
}

const pg = require("pg");
const s = (v) => (v === null || v === undefined ? null : String(v));

function stringifyJson(v) {
  return JSON.stringify(v ?? null);
}

(async () => {
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const wipe = `DELETE FROM settings; DELETE FROM providerConnections; DELETE FROM providerNodes;
    DELETE FROM proxyPools; DELETE FROM proxyPoolFitness; DELETE FROM apiKeys; DELETE FROM combos;
    DELETE FROM kv WHERE scope IN ('modelAliases','customModels','mitmAlias','pricing');`;

  const ins = (sql, params) => client.query(sql, params);

  await client.query("BEGIN");
  try {
    await client.query(wipe);

    if (data.settings) {
      await ins(`INSERT INTO settings(id, data) VALUES(1, $1) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(data.settings)]);
    }
    for (const c of data.providerConnections || []) {
      const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
      await ins(
        `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,authType=excluded.authType,name=excluded.name,email=excluded.email,priority=excluded.priority,isActive=excluded.isActive,data=excluded.data,createdAt=excluded.createdAt,updatedAt=excluded.updatedAt`,
        [id, provider || null, authType || "oauth", s(name), s(email), s(priority), isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const n of data.providerNodes || []) {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      await ins(
        `INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET type=excluded.type,name=excluded.name,data=excluded.data,createdAt=excluded.createdAt,updatedAt=excluded.updatedAt`,
        [id, s(type), s(name), stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const p of data.proxyPools || []) {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      await ins(
        `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET isActive=excluded.isActive,testStatus=excluded.testStatus,data=excluded.data,createdAt=excluded.createdAt,updatedAt=excluded.updatedAt`,
        [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
      );
    }
    for (const f of data.proxyPoolFitness || []) {
      await ins(
        `INSERT INTO proxyPoolFitness(poolId, scope, "until", reason, createdAt, updatedAt) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(poolId,scope) DO UPDATE SET "until"=excluded."until",reason=excluded.reason,createdAt=excluded.createdAt,updatedAt=excluded.updatedAt`,
        [s(f.poolId), s(f.scope), s(f.until), s(f.reason || ""), f.createdAt || new Date().toISOString(), f.updatedAt || new Date().toISOString()]
      );
    }
    for (const k of data.apiKeys || []) {
      await ins(
        `INSERT INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET key=excluded.key,name=excluded.name,machineId=excluded.machineId,isActive=excluded.isActive,createdAt=excluded.createdAt`,
        [k.id, k.key, s(k.name), s(k.machineId), k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString()]
      );
    }
    for (const c of data.combos || []) {
      await ins(
        `INSERT INTO combos(id, name, kind, models, context_length, createdAt, updatedAt) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,models=excluded.models,context_length=excluded.context_length,createdAt=excluded.createdAt,updatedAt=excluded.updatedAt`,
        [c.id, c.name, s(c.kind), stringifyJson(c.models || []), s(c.context_length), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
      );
    }
    const putKv = (scope, key, value) => ins(
      `INSERT INTO kv(scope, key, value) VALUES($1,$2,$3) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value`,
      [scope, key, stringifyJson(value)]
    );
    for (const [a, m] of Object.entries(data.modelAliases || {})) await putKv("modelAliases", a, m);
    for (const m of data.customModels || []) {
      await putKv("customModels", `${m.providerAlias}|${m.id}|${m.type || "llm"}`, m);
    }
    for (const [tool, mappings] of Object.entries(data.mitmAlias || {})) await putKv("mitmAlias", tool, mappings);
    for (const [provider, models] of Object.entries(data.pricing || {})) await putKv("pricing", provider, models);
    await ins(`INSERT INTO _meta(key,value) VALUES('settings_revision','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value`, []);

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  // Verify counts
  const count = async (t) => (await client.query(`SELECT COUNT(*) c FROM ${t}`)).rows[0].c;
  const kvc = (await client.query(`SELECT COUNT(*) c FROM kv WHERE scope='customModels'`)).rows[0].c;
  console.log("IMPORT OK");
  console.log("  settings        :", await count("settings"));
  console.log("  providerConnections:", await count("providerConnections"));
  console.log("  providerNodes   :", await count("providerNodes"));
  console.log("  proxyPools      :", await count("proxyPools"));
  console.log("  proxyPoolFitness:", await count("proxyPoolFitness"));
  console.log("  apiKeys         :", await count("apiKeys"));
  console.log("  combos          :", await count("combos"));
  console.log("  kv customModels :", kvc);
  await client.end();
})().catch((e) => { console.error("IMPORT FAILED:", e.message); process.exit(1); });