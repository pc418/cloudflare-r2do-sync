#!/usr/bin/env node
// Deploys the worker via the Cloudflare REST API exclusively.
// NEVER use the wrangler CLI here: the local wrangler login belongs to a
// different Cloudflare account. Auth comes from ../.env (CLOUDFLARE_TOKEN).
//
// `deployViaRest()` is exported so scripts/setup.mjs can continue in-process with the
// admin token this creates — Cloudflare never reveals a secret again, so scraping it back
// out of stdout would be the only alternative.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bucketOwnershipClaim, ensureR2Bucket, loadWorkerDeployConfig } from "./worker-config.mjs";
import {
  loadEnvFile,
  renderRestDeployCheck,
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
export async function deployViaRest({ log = console.log, confirm = null, adoptBucket = false } = {}) {
  const {
    scriptName: SCRIPT_NAME,
    compatibilityDate: COMPAT_DATE,
    compatibilityFlags: COMPAT_FLAGS,
    bucket: BUCKET,
    durableObjectBinding: DO_BINDING,
    durableObjectClass: DO_CLASS,
    migrationTag: MIGRATION_TAG,
    cron: CRON,
  } = loadWorkerDeployConfig();

  const fileEnv = loadEnvFile(ROOT);
  const required = (name, hint) => {
    const value = process.env[name] ?? fileEnv[name];
    if (!value) throw new Error(`${name} is not set — add it to .env or the environment (${hint})`);
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
  execFileSync(
    path.join(WORKER_DIR, "node_modules", ".bin", "esbuild"),
    [
      "src/index.ts",
      "--bundle",
      "--format=esm",
      "--platform=neutral",
      "--conditions=workerd,worker,browser",
      "--external:cloudflare:workers",
      "--minify",
      "--outfile=dist/worker.js",
    ],
    { cwd: WORKER_DIR, stdio: "inherit" }
  );
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
    ],
  };

  // Which account, which script, which bucket — before anything is created. The wrangler
  // path has always named its target; this one used to create resources on whatever account
  // CLOUDFLARE_ACCOUNT_ID happened to hold. `confirm` is null when setup.mjs already asked.
  const ownedClaim = (process.env.VAULT_BUCKET_OWNED ?? fileEnv.VAULT_BUCKET_OWNED)?.trim() || null;
  if (confirm !== null) {
    const proceed = await confirm(
      renderRestDeployCheck({
        accountId: ACCOUNT_ID,
        scriptName: SCRIPT_NAME,
        bucket: BUCKET,
        bucketOwned: ownedClaim === bucketOwnershipClaim(ACCOUNT_ID, BUCKET),
      })
    );
    if (!proceed) throw new Error("cancelled — nothing was deployed");
  }

  // 2. Storage and workers.dev subdomain (must exist before first upload) ------
  const bucket = await ensureR2Bucket(cf, BUCKET, {
    accountId: ACCOUNT_ID,
    owned: ownedClaim,
    adopt: adoptBucket,
  });
  log(`R2 bucket "${BUCKET}": ${bucket.status}`);

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
  const stored = (process.env.ADMIN_TOKEN ?? fileEnv.ADMIN_TOKEN)?.trim() || null;
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

  return { url, adminToken, adminTokenKept, bucketClaim: bucket.claim };
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
    const assumeYes = argv.includes("--yes") || argv.includes("-y");
    const unknown = argv.find((a) => !["--adopt-bucket", "--yes", "-y"].includes(a));
    if (unknown) throw new Error(`unknown option "${unknown}"\n\nusage: node scripts/deploy.mjs [--adopt-bucket] [--yes]`);

    const { url, adminToken, adminTokenKept, bucketClaim } = await deployViaRest({
      adoptBucket,
      confirm: assumeYes ? null : askToProceed,
    });
    // The admin credential is never shown to a person — it lives in ./.env so the helper
    // scripts (access-token.mjs, setup.mjs) keep working without anyone copying secrets.
    // The bucket claim records that this checkout provisioned that storage, so a later
    // redeploy is an ordinary reuse rather than an unexplained adoption.
    upsertEnvFile(ROOT, {
      WORKER_URL: url,
      ADMIN_TOKEN: adminToken,
      ...(bucketClaim ? { VAULT_BUCKET_OWNED: bucketClaim } : {}),
    });
    console.log(`admin credential ${adminTokenKept ? "unchanged" : "rotated"} — ./.env updated (WORKER_URL, ADMIN_TOKEN)`);
    console.log(`\nDEPLOYED: ${url}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
