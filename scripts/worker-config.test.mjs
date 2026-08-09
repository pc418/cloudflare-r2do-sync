import assert from "node:assert/strict";
import test from "node:test";
import { ensureR2Bucket, parseWorkerDeployConfig } from "./worker-config.mjs";

const VALID = `
// deployment config
{
  "name": "sync-test",
  "compatibility_date": "2026-08-03",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "VAULT_LOCK", "class_name": "VaultLock" }]
  },
  "migrations": [{ "tag": "v7", "new_sqlite_classes": ["VaultLock"] }],
  "r2_buckets": [{ "binding": "VAULT", "bucket_name": "sync-bucket" }],
  "triggers": { "crons": ["0 4 * * *"] }
}`;

test("wrangler JSONC is the single deploy metadata source", () => {
  assert.deepEqual(parseWorkerDeployConfig(VALID), {
    scriptName: "sync-test",
    compatibilityDate: "2026-08-03",
    compatibilityFlags: ["nodejs_compat"],
    bucket: "sync-bucket",
    durableObjectBinding: "VAULT_LOCK",
    durableObjectClass: "VaultLock",
    migrationTag: "v7",
    cron: "0 4 * * *",
  });
});

test("missing required deployment metadata fails loudly", () => {
  assert.throws(
    () => parseWorkerDeployConfig('{ "name": "incomplete" }'),
    /compatibility_date/
  );
});

test("bucket preflight creates only a missing bucket", async () => {
  const calls = [];
  const cf = async (path, init = {}) => {
    calls.push({ path, init });
    if (calls.length === 1) return { status: 404, body: null };
    return { status: 200, body: { success: true } };
  };

  assert.equal(await ensureR2Bucket(cf, "sync-bucket"), "created");
  assert.equal(calls[0].path, "/r2/buckets/sync-bucket");
  assert.deepEqual(JSON.parse(calls[1].init.body), { name: "sync-bucket" });
});

test("bucket preflight fails instead of treating API errors as absence", async () => {
  await assert.rejects(
    ensureR2Bucket(async () => ({ status: 403, body: { error: "denied" } }), "sync-bucket"),
    /bucket preflight failed.*403/
  );
});
