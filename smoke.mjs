// Smoke test: exercise the ported db layer against the live cloud DB.
// Run: DATABASE_URL=... node --input-type=module smoke.mjs
// (read/write/export; non-destructive.)
if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL first.");
  process.exit(1);
}

const db = await import("./src/lib/db/index.js");

function ok(name, cond) {
  console.log((cond ? "PASS" : "FAIL") + "  " + name);
  if (!cond) process.exitCode = 1;
}

// 1. getAdapter() triggers PG init + runPostgresMigration. Must not throw.
console.log("== init (adapter + migration) ==");
const adapter = await db.getAdapter ? db.getAdapter() : (await import("./src/lib/db/driver.js")).getAdapter();
const a = await adapter;
ok("adapter driver is postgres", a.driver === "postgres");

console.log("== reads ==");
const settings = await db.getSettings();
ok("settings loaded, has requireLogin", typeof settings.requireLogin === "boolean");

const conns = await db.getProviderConnections();
ok("providerConnections = 35", conns.length === 35);
ok("first conn has accessToken-ish data", conns[0].provider === "antigravity");

const keys = await db.getApiKeys();
ok("apiKeys = 1", keys.length === 1);
ok("apiKey non-empty", typeof keys[0].key === "string" && keys[0].key.length > 5);

const valid = await db.validateApiKey(keys[0].key);
ok("validateApiKey passes with real key", !!valid && valid.isActive === true);

const combos = await db.getCombos();
ok("combos = 4", combos.length === 4);

// 2. Write roundtrip via updateSettings (exercises transaction read-merge-write + revision bump)
console.log("== write roundtrip (updateSettings) ==");
const before = settings.rtkEnabled;
await db.updateSettings({ rtkEnabled: !before });
const after = await db.getSettings();
ok("updateSettings persisted", after.rtkEnabled !== before);
await db.updateSettings({ rtkEnabled: before }); // revert
const reverted = await db.getSettings();
ok("revert persisted", reverted.rtkEnabled === before);

// 3. importDb/exportDb roundtrip WITHOUT wiping real data is unsafe here; instead
//    exercise exportDb() directly (reads all tables).
console.log("== exportDb ==");
const exported = await db.exportDb();
ok("exportDb has settings", !!exported.settings);
ok("exportDb providerConnections=35", (exported.providerConnections || []).length === 35);
ok("exportDb customModels=764", (exported.customModels || []).length === 764);

console.log("\nDone.");
