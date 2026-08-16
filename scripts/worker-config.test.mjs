import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDeploymentName,
  assertNoRenameFork,
  bucketOwnershipClaim,
  ensureR2Bucket,
  ensureWorkerScript,
  parseDeploymentName,
  parseWorkerDeployConfig,
} from "./worker-config.mjs";

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
  "vars": { "GC_KEEP_DAYS": "30", "GC_KEEP_COUNT": "50" },
  "triggers": { "crons": ["0 4 * * *"] }
}`;

/** The valid config with one `vars` entry replaced, for the retention validation cases. */
function withVar(name, value) {
  const vars = { GC_KEEP_DAYS: "30", GC_KEEP_COUNT: "50", [name]: value };
  if (value === undefined) delete vars[name];
  return VALID.replace(
    '"vars": { "GC_KEEP_DAYS": "30", "GC_KEEP_COUNT": "50" }',
    `"vars": ${JSON.stringify(vars)}`
  );
}

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
    vars: { GC_KEEP_DAYS: "30", GC_KEEP_COUNT: "50" },
  });
});

test("missing required deployment metadata fails loudly", () => {
  assert.throws(
    () => parseWorkerDeployConfig('{ "name": "incomplete" }'),
    /compatibility_date/
  );
});

test("retention has to be a usable integer before anything is uploaded", () => {
  // Every one of these would deploy a Worker whose nightly sweep either throws or deletes
  // history nobody agreed to lose. The deploy path is the last place to catch it cheaply.
  for (const bad of ["0", "-1", "1.5", "thirty", "", "  ", "1e3"]) {
    assert.throws(
      () => parseWorkerDeployConfig(withVar("GC_KEEP_DAYS", bad)),
      /GC_KEEP_DAYS must be an integer from 1 to 3650|requires vars.GC_KEEP_DAYS/,
      `expected "${bad}" to be refused`
    );
  }
  assert.throws(() => parseWorkerDeployConfig(withVar("GC_KEEP_DAYS", "3651")), /1 to 3650/);
  assert.throws(() => parseWorkerDeployConfig(withVar("GC_KEEP_COUNT", "10001")), /1 to 10000/);
  assert.throws(
    () => parseWorkerDeployConfig(withVar("GC_KEEP_COUNT", undefined)),
    /requires vars.GC_KEEP_COUNT/
  );
  // A JSON number would give the local test runtime a different type than the deployed
  // plain_text binding, so it is refused rather than coerced.
  assert.throws(
    () => parseWorkerDeployConfig(withVar("GC_KEEP_COUNT", 50)),
    /requires vars.GC_KEEP_COUNT as a non-empty string/
  );
  assert.throws(() => parseWorkerDeployConfig(VALID.replace('"vars"', '"unused"')), /vars\./);
});

test("valid retention survives the round trip as normalized strings", () => {
  assert.deepEqual(parseWorkerDeployConfig(withVar("GC_KEEP_DAYS", " 7 ")).vars, {
    GC_KEEP_DAYS: "7",
    GC_KEEP_COUNT: "50",
  });
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

test("a rename in the config is refused as the fork it would be", () => {
  const live = {
    scriptName: "sync-test",
    bucket: "sync-bucket",
    accountId: "acct-1",
    workerUrl: "https://sync-test.example.workers.dev",
    bucketOwned: "acct-1:sync-bucket",
  };

  // The ordinary redeploy: everything agrees, nothing is reported.
  assert.deepEqual(assertNoRenameFork(live), []);

  // A renamed script would upload beside the live one, not over it.
  assert.throws(
    () => assertNoRenameFork({ ...live, scriptName: "sync-test-2" }),
    /WORKER_URL is serving "sync-test".*config says "sync-test-2"/s
  );
  // A renamed bucket would be created empty and the vault would not move into it.
  assert.throws(
    () => assertNoRenameFork({ ...live, bucket: "other-bucket" }),
    /provisioned "sync-bucket".*config says "other-bucket"/s
  );
  // Both at once, and the message still has to say the deploy would not rename anything.
  assert.throws(
    () => assertNoRenameFork({ ...live, scriptName: "s2", bucket: "b2" }),
    /SECOND deployment/
  );

  // Deliberate migration proceeds, and still reports what it is about to diverge from.
  assert.deepEqual(
    assertNoRenameFork({ ...live, scriptName: "sync-test-2", allowRename: true }),
    ['Worker: .env WORKER_URL is serving "sync-test", config says "sync-test-2"']
  );
});

test("the rename guard only fires on evidence it actually has", () => {
  const base = { scriptName: "sync-test", bucket: "sync-bucket", accountId: "acct-1" };

  // First deploy from a fresh checkout: .env knows nothing yet.
  assert.deepEqual(assertNoRenameFork(base), []);
  assert.deepEqual(assertNoRenameFork({ ...base, workerUrl: "  ", bucketOwned: "" }), []);

  // A custom domain does not carry the script name, so it is not evidence of a mismatch.
  assert.deepEqual(assertNoRenameFork({ ...base, workerUrl: "https://sync.example.com" }), []);
  // Neither is an unparseable one.
  assert.deepEqual(assertNoRenameFork({ ...base, workerUrl: "not a url" }), []);

  // A claim recorded against a different account says nothing about this one.
  assert.deepEqual(assertNoRenameFork({ ...base, bucketOwned: "acct-9:old-bucket" }), []);
});

// --- named deployments (second vaults) ---------------------------------------

test("a deployment name has to be spellable as both a Worker and a bucket", () => {
  const base = parseWorkerDeployConfig(VALID);

  assert.equal(parseDeploymentName("notes-2", base), "notes-2");
  assert.equal(parseDeploymentName("  notes-2  ", base), "notes-2");

  for (const bad of [
    "ab", // under R2's 3-character minimum
    "-leading",
    "trailing-",
    "Upper-Case",
    "under_score",
    "dot.name",
    "spaced name",
    "a".repeat(64), // past the 63-character ceiling
    "",
    "   ",
  ]) {
    assert.throws(
      () => parseDeploymentName(bad, base),
      /invalid deployment name|deployment name is required/,
      `expected "${bad}" to be refused`
    );
  }
});

test("a deployment name may not be a way to redeploy or delete something else", () => {
  const base = parseWorkerDeployConfig(VALID);

  // The default deployment under a different .env file: the fork guard would be comparing
  // this deploy against a file that has never seen it, so it would sail through.
  assert.throws(() => parseDeploymentName("sync-test", base), /DEFAULT deployment's own name/);
  assert.throws(() => parseDeploymentName("sync-bucket", base), /DEFAULT deployment's own name/);
  // Named in CLAUDE.md as never in scope, on any account.
  assert.throws(() => parseDeploymentName("obsidian", base), /never in scope/);
  // `sandbox.mjs --destroy --all` purges and deletes buckets by this marker, and the live
  // suite uses it to tell a throwaway from a real vault. A vault wearing it is deletable.
  for (const name of ["sandbox", "my-sandbox", "sandbox-notes", "notes-sandbox-2"]) {
    assert.throws(() => parseDeploymentName(name, base), /reserved for throwaway/, name);
  }
});

test("validating a deployment name without the default's names is refused, not skipped", () => {
  // Passing no base would make every reserved-name check vacuously pass, which is the one
  // failure mode that produces a deploy over the default vault's own Worker.
  assert.throws(() => parseDeploymentName("notes-2", undefined), /needs the default deployment/);
  assert.throws(() => parseDeploymentName("notes-2", { scriptName: "only" }), /needs the default deployment/);
});

test("a named deployment moves the Worker and bucket, and nothing else", () => {
  const base = parseWorkerDeployConfig(VALID);
  const named = applyDeploymentName(base, "notes-2");

  assert.equal(named.scriptName, "notes-2");
  assert.equal(named.bucket, "notes-2");
  // The Durable Object class and its migration must NOT be renamed. The namespace is
  // per-script, so the unchanged class under a new script name is already a separate, empty
  // commit log; renaming the class instead would need `renamed_classes` and would be a
  // migration of the existing namespace, which is data loss dressed as a deploy.
  assert.equal(named.durableObjectClass, base.durableObjectClass);
  assert.equal(named.durableObjectBinding, base.durableObjectBinding);
  assert.equal(named.migrationTag, base.migrationTag);
  // Everything a vault's behaviour depends on stays what wrangler.jsonc says.
  assert.deepEqual(named.vars, base.vars);
  assert.equal(named.cron, base.cron);
  assert.equal(named.compatibilityDate, base.compatibilityDate);
  assert.deepEqual(named.compatibilityFlags, base.compatibilityFlags);
  // The base config is not mutated: one process may resolve several deployments.
  assert.equal(base.scriptName, "sync-test");
});

test("a first named deploy will not upload over a Worker it never created", () => {
  // The gap this closes: on a new vault's first deploy `.env.<name>` does not exist, so the
  // fork guard has no evidence; if the account has an unrelated Worker of that name and no
  // bucket to match, the bucket preflight passes too. The upload is a PUT, so it would
  // replace that Worker's code, bindings and cron.
  const present = async () => ({ status: 200, body: { result: { bindings: [] } } });
  return Promise.all([
    assert.rejects(ensureWorkerScript(present, "notes-2"), /already exists.*no\n?\s*record of/s),
    // Recorded ownership is an ordinary redeploy, and costs no request at all.
    ensureWorkerScript(
      async () => assert.fail("an owned deployment must not be looked up"),
      "notes-2",
      { owned: true }
    ).then((r) => assert.equal(r.status, "owned")),
    // ...and an operator can still say the Worker is theirs.
    ensureWorkerScript(present, "notes-2", { adopt: true }).then((r) =>
      assert.equal(r.status, "adopted")
    ),
  ]);
});

test("worker preflight tells absence apart from a failure to ask", async () => {
  assert.deepEqual(
    await ensureWorkerScript(async () => ({ status: 404, body: null }), "notes-2"),
    { status: "absent" }
  );
  // A 403 is not evidence the name is free; treating it as absence is how the overwrite
  // happens on a token that simply cannot read scripts.
  await assert.rejects(
    ensureWorkerScript(async () => ({ status: 403, body: { error: "denied" } }), "notes-2"),
    /worker preflight failed.*403/
  );
});

test("worker preflight asks an endpoint that answers JSON", async () => {
  // Fetching the script itself returns JavaScript, and deploy.mjs's `cf()` throws on a
  // non-JSON body — so the existence check would fail as a parse error on exactly the case
  // it exists to catch.
  let asked = null;
  await ensureWorkerScript(async (p) => {
    asked = p;
    return { status: 404, body: null };
  }, "notes-2");
  assert.equal(asked, "/workers/scripts/notes-2/settings");
});

test("the fork guard names the file it actually compared against", () => {
  // Fed `.env` while deploying a named vault, this guard would refuse every second vault as a
  // rename of production. The file name in the message is how that is visible when it happens.
  assert.throws(
    () =>
      assertNoRenameFork({
        scriptName: "notes-2",
        bucket: "notes-2",
        accountId: "acct-1",
        workerUrl: "https://notes-2-old.example.workers.dev",
        envFile: ".env.notes-2",
      }),
    /\.env\.notes-2 WORKER_URL is serving "notes-2-old"/
  );
});

test("a caller that never opted into ownership tracking keeps the old behaviour", async () => {
  const present = async () => ({ status: 200, body: { success: true } });
  assert.deepEqual(await ensureR2Bucket(present, "sync-bucket"), {
    status: "existing",
    claim: null,
  });
});
