#!/usr/bin/env node
// Stands up (and tears down) THROWAWAY Workers for the live UI test suite.
//
// This is the one place in the repo that runs `wrangler`, and it is deliberately not
// scripts/deploy.mjs. The two paths must never converge: deploy.mjs is the production path and
// authenticates with the REST token in ../.env; this one authenticates with whatever account
// the local wrangler happens to be logged into, which is a different account entirely. The
// account guard below is what keeps that distinction honest — it refuses to run if the
// wrangler login turns out to BE the production account.
//
//   node scripts/sandbox.mjs                     # the default sandbox
//   node scripts/sandbox.mjs --suffix encryption # an isolated one for one test group
//   node scripts/sandbox.mjs --destroy --all     # purge storage, delete every sandbox
//
// One deployment serves one vault: the Durable Object is `getByName("default")` and there is
// exactly one head. Test groups that reroot, force-push or re-key would therefore invalidate
// each other's assumptions, so each such group gets its own Worker and its own bucket.
//
// Credentials land in testvault/.env.sandbox*, never in ../.env: the live suite must not be
// one typo away from pointing at the real vault, and .env is what the production tooling
// reads. Nothing here writes to .env, and nothing here reads a secret out of it except the
// account id, for the comparison that refuses to proceed.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile, waitForHealth } from "./setup-lib.mjs";
import { loadWorkerDeployConfig } from "./worker-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = path.join(ROOT, "worker");
const VAULT_DIR = path.join(ROOT, "testvault");

const envFileFor = (suffix) => path.join(VAULT_DIR, suffix === "" ? ".env.sandbox" : `.env.sandbox.${suffix}`);
/**
 * Sandbox names always carry the `-sandbox` marker, never the bare configured name.
 *
 * That marker is the only thing separating a throwaway from production: both live under the
 * same `wrangler.jsonc` name, on different accounts, and `liveConfig()` refuses any URL
 * without it. A sandbox that could be spelled exactly like the real Worker is one typo away
 * from a suite that force-pushes, reroots and re-keys somebody's real notes.
 */
const SANDBOX_MARK = "sandbox";
const nameFor = (base, suffix) =>
  suffix === "" ? `${base}-${SANDBOX_MARK}` : `${base}-${SANDBOX_MARK}-${suffix}`;
/** Env var suffix: the group name as an identifier, so one process can hold several. */
const varSuffix = (suffix) => (suffix === "" ? "" : `_${suffix.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`);

function wrangler(args, { input } = {}) {
  const run = spawnSync("npx", ["wrangler", ...args], {
    cwd: WORKER_DIR,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (run.error) throw run.error;
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  if (run.status !== 0) throw new Error(`wrangler ${args[0]} failed (exit ${run.status}):\n${output}`);
  return output;
}

const workersDevUrl = (out) => /(https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev)/i.exec(out)?.[1] ?? null;

/**
 * Refuses to touch the production account, whichever way round the mistake is made: a
 * wrangler login that turns out to be production, or a `.env` that has been re-pointed at the
 * sandbox. Either would mean `--destroy` could delete a real vault's storage.
 */
function assertSandboxAccount() {
  const whoami = execFileSync("npx", ["wrangler", "whoami"], { cwd: WORKER_DIR, encoding: "utf8" });
  const id = /\b([0-9a-f]{32})\b/.exec(whoami)?.[1] ?? null;
  if (id === null) throw new Error(`could not read an account id from wrangler whoami:\n${whoami}`);

  const production = (process.env.CLOUDFLARE_ACCOUNT_ID ?? loadEnvFile(ROOT).CLOUDFLARE_ACCOUNT_ID)?.trim();
  if (production && production === id) {
    throw new Error(
      "refusing to run: the wrangler login is the PRODUCTION account.\n\n" +
        "This script deploys throwaway Workers and deletes buckets. It is only ever allowed to\n" +
        "run against the separate sandbox account. Nothing was changed."
    );
  }
  return id;
}

/**
 * wrangler has no CLI override for an R2 binding, so every variant deploy needs its own
 * config file. Generated from the real one rather than hand-written, so a sandbox cannot
 * quietly drift from the deployment it is standing in for — retention, compatibility date and
 * the Durable Object migration are whatever `worker/wrangler.jsonc` says.
 */
function withConfig(fileName, config, run) {
  const full = path.join(WORKER_DIR, fileName);
  writeFileSync(full, JSON.stringify(config, null, 2));
  try {
    return run(fileName);
  } finally {
    rmSync(full, { force: true });
  }
}

function sandboxConfig(base, suffix) {
  return {
    name: nameFor(base.scriptName, suffix),
    main: "src/index.ts",
    compatibility_date: base.compatibilityDate,
    compatibility_flags: base.compatibilityFlags,
    durable_objects: {
      bindings: [{ name: base.durableObjectBinding, class_name: base.durableObjectClass }],
    },
    migrations: [{ tag: base.migrationTag, new_sqlite_classes: [base.durableObjectClass] }],
    r2_buckets: [{ binding: "VAULT", bucket_name: nameFor(base.bucket, suffix) }],
    vars: base.vars,
    triggers: { crons: [base.cron] },
  };
}

async function deploy(suffix) {
  const base = loadWorkerDeployConfig();
  const accountId = assertSandboxAccount();
  const script = nameFor(base.scriptName, suffix);
  const bucket = nameFor(base.bucket, suffix);
  console.log(`sandbox account ${accountId.slice(0, 8)}…, Worker "${script}"`);

  // The bucket has to exist before the first upload names it as a binding.
  const created = wrangler(["r2", "bucket", "create", bucket]);
  console.log(`bucket ${bucket}: ${/already exists/i.test(created) ? "existing" : "created"}`);

  const out = withConfig(`.sandbox-${suffix || "default"}.jsonc`, sandboxConfig(base, suffix), (file) =>
    wrangler(["deploy", "-c", file])
  );
  const url = workersDevUrl(out);
  if (url === null) throw new Error(`no workers.dev URL in the deploy output:\n${out}`);
  console.log(`deployed ${url}`);

  // A fresh admin credential every time. The sandbox is disposable; carrying one over would
  // only create something worth protecting.
  const adminToken = randomBytes(32).toString("hex");
  wrangler(["secret", "put", "ADMIN_TOKEN", "--name", script], { input: `${adminToken}\n` });
  await waitForHealth(url);

  const minted = await fetch(`${url}/api/tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "live-ui-suite", scopes: ["sync", "reroot"] }),
  });
  if (!minted.ok) throw new Error(`token mint failed with HTTP ${minted.status}: ${await minted.text()}`);
  const accessToken = (await minted.json()).token;
  if (typeof accessToken !== "string" || accessToken === "") throw new Error("mint returned no token");

  const v = varSuffix(suffix);
  mkdirSync(VAULT_DIR, { recursive: true });
  writeFileSync(
    envFileFor(suffix),
    [
      "# Throwaway sandbox credentials for `npm run test:live`. Not production.",
      "# Regenerate with `node scripts/sandbox.mjs`; revoke with `--destroy`.",
      `R2DO_LIVE_URL${v}=${url}`,
      `R2DO_LIVE_TOKEN${v}=${accessToken}`,
      `R2DO_SANDBOX_ADMIN${v}=${adminToken}`,
      "",
    ].join("\n"),
    { mode: 0o600 }
  );
  console.log(`wrote ${path.relative(ROOT, envFileFor(suffix))} (mode 600)\n\nSANDBOX READY: ${url}`);
}

/**
 * R2 refuses to delete a bucket that still has objects in it, and wrangler cannot list them.
 * So the bucket empties itself: a throwaway Worker bound to it, deployed, invoked, deleted.
 * That costs one extra script for a few seconds and leaves nothing behind, which beats
 * abandoning a bucket of test snapshots on an account that has four unrelated ones.
 */
async function purgeBucket(base, suffix) {
  const name = `${nameFor(base.scriptName, suffix)}-purge`;
  const bucket = nameFor(base.bucket, suffix);
  const secret = randomBytes(16).toString("hex");
  const script = `export default {
  async fetch(request, env) {
    if (new URL(request.url).searchParams.get("k") !== ${JSON.stringify(secret)}) {
      return new Response("no", { status: 403 });
    }
    let deleted = 0, cursor = undefined;
    do {
      const page = await env.VAULT.list({ cursor, limit: 1000 });
      const keys = page.objects.map((o) => o.key);
      for (let i = 0; i < keys.length; i += 100) await env.VAULT.delete(keys.slice(i, i + 100));
      deleted += keys.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return Response.json({ deleted });
  },
};
`;
  const scriptFile = path.join(WORKER_DIR, `.sandbox-purge-${suffix || "default"}.mjs`);
  writeFileSync(scriptFile, script);
  let url;
  try {
    const out = withConfig(`.sandbox-purge-${suffix || "default"}.jsonc`, {
      name,
      main: path.basename(scriptFile),
      compatibility_date: base.compatibilityDate,
      r2_buckets: [{ binding: "VAULT", bucket_name: bucket }],
    }, (file) => wrangler(["deploy", "-c", file]));
    url = workersDevUrl(out);
    if (url === null) throw new Error(`purge worker did not report a URL:\n${out}`);
  } finally {
    rmSync(scriptFile, { force: true });
  }

  // A fresh deploy is not instantly routable. The purge is not optional, so this waits rather
  // than reporting a bucket as empty that was never actually read.
  let report = null;
  for (let attempt = 0; attempt < 25 && report === null; attempt += 1) {
    const res = await fetch(`${url}/?k=${secret}`);
    if (res.ok) report = await res.json();
    else await new Promise((r) => setTimeout(r, 1000));
  }
  if (report === null) throw new Error(`purge worker never answered — ${bucket} not emptied, nothing deleted`);
  console.log(`purged ${report.deleted} object(s) from ${bucket}`);
  wrangler(["delete", "--name", name, "--force"]);
  return bucket;
}

async function destroy(suffix) {
  const base = loadWorkerDeployConfig();
  assertSandboxAccount();
  const script = nameFor(base.scriptName, suffix);
  console.log(`tearing down "${script}"`);

  const bucket = await purgeBucket(base, suffix);
  // Deleting the script deletes its Durable Object namespace and its cron trigger with it.
  wrangler(["delete", "--name", script, "--force"]);
  wrangler(["r2", "bucket", "delete", bucket]);
  rmSync(envFileFor(suffix), { force: true });
  console.log(`deleted Worker ${script} and bucket ${bucket}`);
}

/** Every sandbox this checkout stood up, read back from the credential files it wrote. */
function knownSuffixes() {
  let entries = [];
  try {
    entries = readdirSync(VAULT_DIR);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return entries
    .filter((name) => name === ".env.sandbox" || name.startsWith(".env.sandbox."))
    .map((name) => (name === ".env.sandbox" ? "" : name.slice(".env.sandbox.".length)))
    .sort();
}

const argv = process.argv.slice(2);
const known = ["--destroy", "--all", "--suffix"];
const unknown = argv.find((a, i) => !known.includes(a) && argv[i - 1] !== "--suffix");
if (unknown) {
  console.error(`unknown option "${unknown}"\n\nusage: node scripts/sandbox.mjs [--suffix <name>] [--destroy [--all]]`);
  process.exit(1);
}
const suffixArg = argv.includes("--suffix") ? (argv[argv.indexOf("--suffix") + 1] ?? "") : "";
if (argv.includes("--suffix") && !/^[a-z][a-z0-9-]{0,24}$/.test(suffixArg)) {
  console.error(`--suffix must be a short lowercase name (Worker and bucket names are built from it)`);
  process.exit(1);
}

try {
  if (!argv.includes("--destroy")) {
    await deploy(suffixArg);
  } else if (argv.includes("--all")) {
    const all = knownSuffixes();
    if (all.length === 0) console.log("no sandbox credentials found — nothing to tear down");
    for (const suffix of all) await destroy(suffix);
    // Only once every deployment it describes is gone, so an interrupted teardown leaves the
    // record of what still exists rather than an orphan nobody can find.
    rmSync(VAULT_DIR, { recursive: true, force: true });
    console.log(`\nremoved ${path.relative(ROOT, VAULT_DIR)}/\nSANDBOXES DESTROYED`);
  } else {
    await destroy(suffixArg);
    console.log("\nSANDBOX DESTROYED");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
