import assert from "node:assert/strict";
import test from "node:test";
import { bucketOwnershipClaim, ensureR2Bucket, parseWorkerDeployConfig } from "./worker-config.mjs";

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

  assert.deepEqual(await ensureR2Bucket(cf, "sync-bucket"), { status: "created", claim: null });
  assert.equal(calls[0].path, "/r2/buckets/sync-bucket");
  assert.deepEqual(JSON.parse(calls[1].init.body), { name: "sync-bucket" });
});

test("an existing bucket this checkout never created is not silently adopted", async () => {
  // The bucket name is a static string in wrangler.jsonc. On an account that already has one
  // by that name, adopting it would point the vault — and GC's deletes — at someone else's
  // storage, with nothing in the output saying so.
  const present = async () => ({ status: 200, body: { success: true } });

  await assert.rejects(
    ensureR2Bucket(present, "sync-bucket", { accountId: "acct-1" }),
    /already exists.*no record of/s
  );

  // An ordinary redeploy: this checkout's .env already claims it.
  assert.deepEqual(
    await ensureR2Bucket(present, "sync-bucket", {
      accountId: "acct-1",
      owned: bucketOwnershipClaim("acct-1", "sync-bucket"),
    }),
    { status: "existing", claim: "acct-1:sync-bucket" }
  );

  // The claim is per account: the same name elsewhere is different storage.
  await assert.rejects(
    ensureR2Bucket(present, "sync-bucket", {
      accountId: "acct-2",
      owned: bucketOwnershipClaim("acct-1", "sync-bucket"),
    }),
    /already exists/
  );

  // ...and an operator can still say "yes, that one is mine".
  assert.equal(
    (await ensureR2Bucket(present, "sync-bucket", { accountId: "acct-1", adopt: true })).status,
    "existing"
  );
});

test("bucket preflight fails instead of treating API errors as absence", async () => {
  await assert.rejects(
    ensureR2Bucket(async () => ({ status: 403, body: { error: "denied" } }), "sync-bucket"),
    /bucket preflight failed.*403/
  );
});

test("a caller that never opted into ownership tracking keeps the old behaviour", async () => {
  const present = async () => ({ status: 200, body: { success: true } });
  assert.deepEqual(await ensureR2Bucket(present, "sync-bucket"), {
    status: "existing",
    claim: null,
  });
});
