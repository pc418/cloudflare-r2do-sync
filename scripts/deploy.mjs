#!/usr/bin/env node
// Deploys the worker via the Cloudflare REST API exclusively.
// NEVER use the wrangler CLI here: the local wrangler login belongs to a
// different Cloudflare account. Auth comes from ../.env (CLOUDFLARE_TOKEN).
//
// `deployViaRest()` is exported so scripts/setup.mjs can continue in-process with the
// admin token this creates — Cloudflare never reveals a secret again, so scraping it back
// out of stdout would be the only alternative.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyDeploymentName,
  assertNoRenameFork,
  bucketOwnershipClaim,
  ensureR2Bucket,
  ensureWorkerScript,
  loadWorkerDeployConfig,
  parseDeploymentName,
} from "./worker-config.mjs";
import {
  localBin,
  renderRestDeployCheck,
  resolveDeploymentEnv,
  resolveDeploymentRequest,
  upsertEnvFile,
  verifyAdminToken,
  waitForHealth,
} from "./setup-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = path.join(ROOT, "worker");

/** Source of truth for retained Worker logs on REST deployments. */
export const WORKER_OBSERVABILITY = { enabled: true, head_sampling_rate: 0.01 };

/**
 * Runs the whole REST deployment. Returns the live URL plus a *working* admin token:
 * the stored one when it still matches the deployed secret (`adminTokenKept`), otherwise
 * a fresh one that replaced it. Rotation is safe — access tokens live in the Durable
 * Object — and it is what guarantees every run can issue tokens afterwards.
 */
export async function deployViaRest({
  log = console.log,
  confirm = null,
  adoptBucket = false,
  adoptWorker = false,
  migrateRename = false,
  deploymentName = null,
} = {}) {
  const base = loadWorkerDeployConfig();
  // Validated against the default deployment's own names, so a "second vault" that is really
  // the first one under a different .env file is refused before anything is created.
  const VAULT = deploymentName === null ? null : parseDeploymentName(deploymentName, base);
  const {
    scriptName: SCRIPT_NAME,
    compatibilityDate: COMPAT_DATE,
    compatibilityFlags: COMPAT_FLAGS,
    bucket: BUCKET,
    durableObjectBinding: DO_BINDING,
    durableObjectClass: DO_CLASS,
    migrationTag: MIGRATION_TAG,
    cron: CRON,
    vars: VARS,
  } = VAULT === null ? base : applyDeploymentName(base, VAULT);

  // Account credentials fall back to .env; this deployment's URL, admin token and bucket
  // claim come only from its own file. See `resolveDeploymentEnv`.
  const { env: fileEnv, file: ENV_FILE } = resolveDeploymentEnv({ root: ROOT, deploymentName: VAULT });
  const required = (name, hint) => {
    const value = fileEnv[name];
    if (!value) {
      throw new Error(`${name} is not set — add it to .env or the environment (${hint})`);
    }
    return value;
  };

  const TOKEN = required("CLOUDFLARE_TOKEN", "scopes: Workers Scripts:Edit, Workers R2 Storage:Edit");
  const ACCOUNT_ID = required("CLOUDFLARE_ACCOUNT_ID", "Cloudflare dashboard → Workers → Account ID");
  const SUBDOMAIN_WANTED = `log-sync-${ACCOUNT_ID.slice(0, 8)}`;
  const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

  async function cf(pathname, init = {}) {
    const res = await fetch(`${API}${pathname}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
    });
    const raw = await res.text();
    let body = null;
    if (raw !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        throw new Error(`Cloudflare API returned non-JSON HTTP ${res.status} for ${pathname}`);
      }
    }
    return { status: res.status, body };
  }

  const fail = (step, detail) => {
    throw new Error(`FAIL [${step}]: ${JSON.stringify(detail, null, 2)}`);
  };

  // 1. Bundle -----------------------------------------------------------------
  log("bundling worker...");
  // esbuild's JS API rather than its CLI, because there is no portable way to spawn that
  // CLI. `node_modules/.bin/esbuild` is a `.cmd` shim on Windows (ENOENT unshelled — issue
  // #9), and `node_modules/esbuild/bin/esbuild` cannot stand in for it: esbuild's postinstall
  // REPLACES that file with the raw platform executable, so whether it is JS or a Mach-O/PE
  // binary depends on whether install scripts were allowed to run. The API has no spawn and
  // no shim, so it is the same call on every platform and every install state.
  const esbuild = await import(pathToFileURL(localBin(WORKER_DIR, "esbuild/lib/main.js")).href);
  await esbuild.build({
    absWorkingDir: WORKER_DIR,
    entryPoints: ["src/index.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers"],
    minify: true,
    outfile: "dist/worker.js",
  });
  const bundled = readFileSync(path.join(WORKER_DIR, "dist", "worker.js"), "utf8");
  log(`bundle: ${(bundled.length / 1024).toFixed(1)} KiB`);

  const metadataBase = {
    main_module: "worker.js",
    compatibility_date: COMPAT_DATE,
    compatibility_flags: COMPAT_FLAGS,
    keep_secrets: true,
    observability: WORKER_OBSERVABILITY,
    bindings: [
      { type: "r2_bucket", name: "VAULT", bucket_name: BUCKET },
      { type: "durable_object_namespace", name: DO_BINDING, class_name: DO_CLASS },
      // Retention. Every upload restates them, so wrangler.jsonc is the single source of
      // truth: there is no way for a deployed Worker to keep a value the tree no longer has.
      ...Object.entries(VARS).map(([name, text]) => ({ type: "plain_text", name, text })),
    ],
  };

  // Which account, which script, which bucket — before anything is created. The wrangler
  // path has always named its target; this one used to create resources on whatever account
  // CLOUDFLARE_ACCOUNT_ID happened to hold. `confirm` is null when setup.mjs already asked.
  const ownedClaim = fileEnv.VAULT_BUCKET_OWNED?.trim() || null;

  // Before the confirmation screen, not after: a fork is not something to be talked into.
  // Scoped to this deployment's own file — compared against production's `.env`, every named
  // deploy would look like a rename fork of it.
  assertNoRenameFork({
    scriptName: SCRIPT_NAME,
    bucket: BUCKET,
    accountId: ACCOUNT_ID,
    workerUrl: fileEnv.WORKER_URL ?? null,
    bucketOwned: ownedClaim,
    allowRename: migrateRename,
    envFile: ENV_FILE,
  });

  if (VAULT !== null) log(`deployment "${VAULT}" — separate vault, credentials in ${ENV_FILE}`);

  if (confirm !== null) {
    const proceed = await confirm(
      renderRestDeployCheck({
        accountId: ACCOUNT_ID,
        scriptName: SCRIPT_NAME,
        bucket: BUCKET,
        bucketOwned: ownedClaim === bucketOwnershipClaim(ACCOUNT_ID, BUCKET),
        retention: VARS,
        deploymentName: VAULT,
        envFile: ENV_FILE,
      })
    );
    if (!proceed) throw new Error("cancelled — nothing was deployed");
  }

  // 2. Storage and workers.dev subdomain (must exist before first upload) ------
  // The script check comes before the bucket is created, so a refusal leaves nothing behind.
  // Named deployments only: the default deployment's name comes from `wrangler.jsonc` and is
  // this repo's own, and adding a preflight there would refuse the ordinary first deploy from
  // a checkout whose .env was never kept.
  if (VAULT !== null) {
    const script = await ensureWorkerScript(cf, SCRIPT_NAME, {
      // A recorded URL is proof a previous deploy from this checkout put it there, and the
      // fork guard above has already checked it against this script name.
      owned: Boolean(fileEnv.WORKER_URL?.trim()),
      adopt: adoptWorker,
    });
    log(`Worker "${SCRIPT_NAME}": ${script.status}`);
  }

  const bucket = await ensureR2Bucket(cf, BUCKET, {
    accountId: ACCOUNT_ID,
    owned: ownedClaim,
    adopt: adoptBucket,
  });
  log(`R2 bucket "${BUCKET}": ${bucket.status}`);
  // Stated even with --yes, which skips the confirmation screen that would otherwise say it.
  log(`GC retention: ${VARS.GC_KEEP_DAYS} day(s), newest ${VARS.GC_KEEP_COUNT} snapshot(s)`);

  let sub = await cf(`/workers/subdomain`);
  let subdomain = sub.body?.result?.subdomain ?? null;
  if (!subdomain) {
    log(`registering workers.dev subdomain "${SUBDOMAIN_WANTED}"...`);
    const create = await cf(`/workers/subdomain`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subdomain: SUBDOMAIN_WANTED }),
    });
    if (create.status !== 200) fail("create-subdomain", create);
    subdomain = create.body.result.subdomain;
  }

  async function uploadScript(withMigrations) {
    const metadata = withMigrations
      ? {
          ...metadataBase,
          migrations: { new_tag: MIGRATION_TAG, new_sqlite_classes: [DO_CLASS] },
        }
      : metadataBase;
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append(
      "worker.js",
      new Blob([bundled], { type: "application/javascript+module" }),
      "worker.js"
    );
    return cf(`/workers/scripts/${SCRIPT_NAME}`, { method: "PUT", body: form });
  }

  log("uploading script...");
  let up = await uploadScript(true);
  if (up.status !== 200 && JSON.stringify(up.body ?? "").includes("migration")) {
    log("migration tag already applied, retrying without migrations...");
    up = await uploadScript(false);
  }
  if (up.status !== 200) fail("upload", up);
  log("script uploaded");

  // 3. per-script workers.dev routing -----------------------------------------
  const enable = await cf(`/workers/scripts/${SCRIPT_NAME}/subdomain`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
  });
  if (enable.status !== 200) fail("enable-subdomain", enable);

  // 4. GC cron ----------------------------------------------------------------
  const cron = await cf(`/workers/scripts/${SCRIPT_NAME}/schedules`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([{ cron: CRON }]),
  });
  if (cron.status !== 200) fail("cron", cron);

  // 5. Smoke test -------------------------------------------------------------
  const url = `https://${SCRIPT_NAME}.${subdomain}.workers.dev`;
  log(`smoke testing ${url}/health ...`);
  if (!(await waitForHealth({ workerUrl: url }))) {
    fail("smoke", `${url}/health did not return {"ok":true} within 60s`);
  }

  // 6. Admin secret — after the smoke test, so a stored credential is always checked
  // against a URL that answers. Reuse it when it still matches; rotate otherwise.
  const secrets = await cf(`/workers/scripts/${SCRIPT_NAME}/secrets`);
  if (secrets.status !== 200) fail("list-secrets", secrets);
  const hasAdmin = (secrets.body.result ?? []).some((s) => s.name === "ADMIN_TOKEN");
  const stored = fileEnv.ADMIN_TOKEN?.trim() || null;
  let adminToken = null;
  let adminTokenKept = false;
  if (hasAdmin && stored) {
    if (await verifyAdminToken({ workerUrl: url, adminToken: stored })) {
      adminToken = stored;
      adminTokenKept = true;
      log("ADMIN_TOKEN secret unchanged — the stored credential still matches");
    } else {
      log("stored ADMIN_TOKEN is stale — rotating the secret (access tokens are unaffected)");
    }
  } else if (hasAdmin) {
    log("no stored ADMIN_TOKEN for the existing secret — rotating it");
  }
  if (adminToken === null) {
    adminToken = randomBytes(32).toString("hex");
    const put = await cf(`/workers/scripts/${SCRIPT_NAME}/secrets`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ADMIN_TOKEN", text: adminToken, type: "secret_text" }),
    });
    if (put.status !== 200 && put.status !== 201) fail("put-secret", put);
  }

  return { url, adminToken, adminTokenKept, bucketClaim: bucket.claim, envFile: ENV_FILE, deploymentName: VAULT };
}

/** Prints the target and waits for a yes. No terminal means no unattended provisioning. */
async function askToProceed(text) {
  console.log(text);
  if (!process.stdin.isTTY) {
    console.error("no terminal to confirm on — re-run with --yes if this target is correct");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question("Deploy to this target? [y/N] ", resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    const argv = process.argv.slice(2);
    const adoptBucket = argv.includes("--adopt-bucket");
    const adoptWorker = argv.includes("--adopt-worker");
    const assumeYes = argv.includes("--yes") || argv.includes("-y");
    const migrateRename = argv.includes("--migrate-rename");
    const known = ["--adopt-bucket", "--adopt-worker", "--yes", "-y", "--migrate-rename", "--vault"];
    const unknown = argv.find((a, i) => !known.includes(a) && argv[i - 1] !== "--vault");
    if (unknown) {
      throw new Error(
        `unknown option "${unknown}"\n\n` +
          "usage: node scripts/deploy.mjs [--vault <name>] [--adopt-bucket] [--adopt-worker]\n" +
          "                               [--migrate-rename] [--yes]"
      );
    }
    const vaultFlag = argv.includes("--vault") ? (argv[argv.indexOf("--vault") + 1] ?? "") : null;
    if (vaultFlag !== null && (vaultFlag === "" || vaultFlag.startsWith("--"))) {
      throw new Error("--vault needs a name");
    }
    const { requested: deploymentName, source } = resolveDeploymentRequest({ flag: vaultFlag });
    // Said out loud before anything is created: a VAULT_NAME left exported in an old shell
    // would otherwise redirect the deploy to another vault with nothing on screen saying so.
    if (deploymentName !== null) {
      console.log(`deploying vault "${deploymentName}" (from ${source})`);
    }
    // --migrate-rename is never implied by --yes. Skipping the confirmation screen is a
    // statement about typing; standing up a second deployment is not.
    if (migrateRename && assumeYes) {
      throw new Error("--migrate-rename cannot be combined with --yes: confirm the target by hand");
    }

    const { url, adminToken, adminTokenKept, bucketClaim, envFile } = await deployViaRest({
      adoptBucket,
      adoptWorker,
      migrateRename,
      deploymentName,
      confirm: assumeYes ? null : askToProceed,
    });
    // The admin credential is never shown to a person — it lives in the deployment's env file
    // so the helper scripts (access-token.mjs, setup.mjs) keep working without anyone copying
    // secrets. The bucket claim records that this checkout provisioned that storage, so a
    // later redeploy is an ordinary reuse rather than an unexplained adoption. A named vault
    // writes to .env.<name>: overwriting .env would replace production's identity with it.
    upsertEnvFile(
      ROOT,
      {
        WORKER_URL: url,
        ADMIN_TOKEN: adminToken,
        ...(bucketClaim ? { VAULT_BUCKET_OWNED: bucketClaim } : {}),
      },
      envFile
    );
    console.log(`admin credential ${adminTokenKept ? "unchanged" : "rotated"} — ./${envFile} updated (WORKER_URL, ADMIN_TOKEN)`);
    console.log(`\nDEPLOYED: ${url}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
