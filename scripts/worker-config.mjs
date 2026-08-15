import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_PACKAGE = path.join(ROOT, "worker", "package.json");
const requireFromWorker = createRequire(WORKER_PACKAGE);
const { parse, printParseErrorCode } = requireFromWorker("jsonc-parser");

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`worker config requires ${field}`);
  }
  return value;
}

/**
 * Retention is the storage lever for this design — retained snapshots restate the whole path
 * map, so history, not blob content, is most of the bucket. It is validated here as well as in
 * the Worker so a typo is refused before it is uploaded, rather than at 04:00 by a sweep that
 * then deletes nothing until someone reads the logs.
 */
export const GC_RETENTION_VARS = {
  GC_KEEP_DAYS: { max: 3650 },
  GC_KEEP_COUNT: { max: 10_000 },
};

function retentionVars(vars) {
  if (vars !== undefined && (typeof vars !== "object" || vars === null || Array.isArray(vars))) {
    throw new Error("worker config vars must be an object");
  }
  const out = {};
  for (const [name, { max }] of Object.entries(GC_RETENTION_VARS)) {
    const raw = vars?.[name];
    // Strings only, matching the plain_text binding the deploy uploads. A JSON number here
    // would give the local test runtime a different type than the deployed Worker sees.
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(`worker config requires vars.${name} as a non-empty string`);
    }
    // Plain decimal digits only. `Number()` alone would quietly accept "1e3" and "0x10",
    // which is not a spelling anyone intends for a retention window.
    const trimmed = raw.trim();
    const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(`worker config vars.${name} must be an integer from 1 to ${max}, not "${raw}"`);
    }
    out[name] = String(value);
  }
  return out;
}

/** Validates and selects the wrangler fields used by the REST deployment path. */
export function parseWorkerDeployConfig(source) {
  const errors = [];
  const config = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const detail = errors.map((e) => `${printParseErrorCode(e.error)} at ${e.offset}`).join(", ");
    throw new Error(`invalid worker/wrangler.jsonc: ${detail}`);
  }

  const scriptName = requiredString(config?.name, "name");
  const compatibilityDate = requiredString(config?.compatibility_date, "compatibility_date");
  const compatibilityFlags = config?.compatibility_flags ?? [];
  if (!Array.isArray(compatibilityFlags) || compatibilityFlags.some((f) => typeof f !== "string")) {
    throw new Error("worker config compatibility_flags must be a string array");
  }

  const r2 = config?.r2_buckets?.find((b) => b?.binding === "VAULT");
  const bucket = requiredString(r2?.bucket_name, 'r2_buckets binding "VAULT"');
  const durable = config?.durable_objects?.bindings?.find((b) => b?.name === "VAULT_LOCK");
  const durableObjectClass = requiredString(
    durable?.class_name,
    'durable_objects binding "VAULT_LOCK"'
  );
  const migration = config?.migrations?.find((m) =>
    m?.new_sqlite_classes?.includes(durableObjectClass)
  );
  const migrationTag = requiredString(migration?.tag, `SQLite migration for ${durableObjectClass}`);
  const crons = config?.triggers?.crons;
  if (!Array.isArray(crons) || crons.length !== 1) {
    throw new Error("worker config requires exactly one triggers.crons entry");
  }

  return {
    scriptName,
    compatibilityDate,
    compatibilityFlags,
    bucket,
    durableObjectBinding: "VAULT_LOCK",
    durableObjectClass,
    migrationTag,
    cron: requiredString(crons[0], "triggers.crons[0]"),
    vars: retentionVars(config?.vars),
  };
}

export function loadWorkerDeployConfig(
  configPath = path.join(ROOT, "worker", "wrangler.jsonc")
) {
  return parseWorkerDeployConfig(readFileSync(configPath, "utf8"));
}

/**
 * Identifies "the bucket this deployment created" for one account. The bucket name is a
 * static string in `wrangler.jsonc`, so on any account that happens to already have a bucket
 * by that name, the old preflight silently adopted it — pointing this Worker's vault, GC
 * included, at storage it never provisioned. The claim is recorded per account because the
 * same name on a different account is a different bucket.
 */
export function bucketOwnershipClaim(accountId, bucket) {
  return `${accountId}:${bucket}`;
}

/**
 * Refuses a deploy that would fork the live deployment instead of updating it.
 *
 * Renaming the Worker or the bucket in `wrangler.jsonc` is not an edit to the deployment —
 * it is a *second* deployment. The upload creates a new script at a new workers.dev URL with
 * an empty Durable Object, `ensureR2Bucket` finds the new name absent and cheerfully creates
 * empty storage for it, and every existing device keeps talking to the old Worker, which is
 * still there and still serving. Nothing errors. The failure is silent, and it looks like a
 * successful deploy.
 *
 * `.env` is what remembers where the live deployment actually is: `WORKER_URL` was written by
 * the last successful deploy, and `VAULT_BUCKET_OWNED` records which bucket this checkout
 * provisioned. Either one disagreeing with the config is the signal.
 *
 * A custom domain carries no script name, so it is not evidence and is not treated as any.
 */
export function assertNoRenameFork({
  scriptName,
  bucket,
  accountId,
  workerUrl = null,
  bucketOwned = null,
  allowRename = false,
}) {
  const conflicts = [];

  const url = workerUrl?.trim();
  if (url) {
    let host = null;
    try {
      host = new URL(url).hostname;
    } catch {
      host = null;
    }
    // Only a workers.dev host names its script; anything else tells us nothing.
    if (host?.endsWith(".workers.dev")) {
      const deployed = host.slice(0, host.indexOf("."));
      if (deployed !== scriptName) {
        conflicts.push(`Worker: .env WORKER_URL is serving "${deployed}", config says "${scriptName}"`);
      }
    }
  }

  const owned = bucketOwned?.trim();
  if (owned) {
    const split = owned.lastIndexOf(":");
    const ownedAccount = split === -1 ? null : owned.slice(0, split);
    const ownedBucket = split === -1 ? owned : owned.slice(split + 1);
    // A claim from a different account says nothing about this one.
    if (ownedAccount === accountId && ownedBucket !== bucket) {
      conflicts.push(`Bucket: this checkout provisioned "${ownedBucket}", config says "${bucket}"`);
    }
  }

  if (conflicts.length === 0 || allowRename) return conflicts;

  throw new Error(
    `refusing to deploy: the configured names do not match the live deployment.\n\n` +
      conflicts.map((c) => `  ${c}`).join("\n") +
      `\n\nDeploying now would not rename anything. It would create a SECOND deployment —\n` +
      `new URL, empty Durable Object, empty bucket — while your devices keep syncing to the\n` +
      `old one, which stays up. The vault would not move with it.\n\n` +
      `Renaming a live deployment means migrating it: stand the new one up, copy the bucket,\n` +
      `re-point every device, then retire the old Worker. If that is what you are doing and\n` +
      `you have read the runbook, re-run with --migrate-rename.`
  );
}

/**
 * GET distinguishes an existing bucket from authorization/server failures before POST.
 *
 * An absent bucket is created and claimed. An existing one is used only when this repo's
 * `.env` already claims it (an ordinary redeploy) or the operator adopts it explicitly —
 * never merely because the name matched.
 */
export async function ensureR2Bucket(cf, bucket, { accountId = null, owned = null, adopt = false } = {}) {
  const claim = accountId === null ? null : bucketOwnershipClaim(accountId, bucket);
  const pathName = `/r2/buckets/${encodeURIComponent(bucket)}`;
  const found = await cf(pathName);
  if (found.status === 200) {
    // `accountId === null` keeps the old unconditional behaviour for callers that have not
    // opted into ownership tracking, so this cannot silently break an embedding script.
    if (claim === null || adopt || owned === claim) return { status: "existing", claim };
    throw new Error(
      `R2 bucket "${bucket}" already exists on this account and this checkout has no record of\n` +
        "creating it. Deploying would point the vault at storage it did not provision — and GC\n" +
        "deletes objects in it. If it really is yours, re-run with --adopt-bucket; otherwise\n" +
        'change "bucket_name" in worker/wrangler.jsonc.'
    );
  }
  if (found.status !== 404) {
    throw new Error(`bucket preflight failed with HTTP ${found.status}: ${JSON.stringify(found.body)}`);
  }

  const created = await cf("/r2/buckets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: bucket }),
  });
  if (created.status !== 200) {
    throw new Error(`bucket create failed with HTTP ${created.status}: ${JSON.stringify(created.body)}`);
  }
  return { status: "created", claim };
}
