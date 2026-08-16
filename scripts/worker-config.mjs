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
 * A deployment name stands up a WHOLE SECOND VAULT, not a variant of the first.
 *
 * It names the Worker script and the R2 bucket, and the Durable Object comes with it for
 * free: DO namespaces are per-script, so uploading the unchanged `VaultLock` class under a
 * new script name creates a fresh, empty namespace with its own authoritative head. That is
 * Cloudflare's model, not something this repo implements — which is also why the class and
 * the `new_sqlite_classes` migration must stay exactly as they are. `renamed_classes` is for
 * moving a namespace; nothing here moves one.
 *
 * The outer bound is the intersection of what Workers and R2 accept for a name: 3–63
 * characters, lowercase letters, digits and hyphens, no leading or trailing hyphen. The
 * refusals past that are this repo's, and each one is a way to lose a vault rather than a
 * style rule.
 */
export const DEPLOYMENT_NAME_RULE =
  "3-63 characters, lowercase letters, digits and hyphens, not starting or ending with a hyphen";
export const DEPLOYMENT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
/** Claimed by scripts/sandbox.mjs and by the live suite's `liveConfig()`. */
const SANDBOX_MARKER = "sandbox";
/** Named in CLAUDE.md as never in scope, on any account, for any reason. */
const FOREIGN_BUCKET = "obsidian";

export function parseDeploymentName(value, base) {
  if (typeof base?.scriptName !== "string" || typeof base?.bucket !== "string") {
    // Without the default deployment's names there is no way to tell a second vault from a
    // sideways redeploy of the first, so this refuses rather than checking less.
    throw new Error("parseDeploymentName needs the default deployment's scriptName and bucket");
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("a deployment name is required — pass --vault <name>");
  }
  const name = value.trim();
  if (!DEPLOYMENT_NAME_RE.test(name)) {
    throw new Error(
      `invalid deployment name "${name}" — it becomes a Worker script name and an R2 bucket ` +
        `name, so it must be ${DEPLOYMENT_NAME_RULE}.`
    );
  }
  if (name === base.scriptName || name === base.bucket) {
    throw new Error(
      `"${name}" is the DEFAULT deployment's own name. Naming it would not create a second\n` +
        "vault — it would deploy the existing one while reading a different .env file, so the\n" +
        "fork guard would be checking against a file that has never seen it. Deploy the default\n" +
        "vault with no --vault at all."
    );
  }
  if (name === FOREIGN_BUCKET) {
    throw new Error(`"${FOREIGN_BUCKET}" is an unrelated bucket and is never in scope for this repo.`);
  }
  if (name.includes(SANDBOX_MARKER)) {
    throw new Error(
      `"${name}" carries the "${SANDBOX_MARKER}" marker, which is reserved for throwaway test\n` +
        "deployments. `node scripts/sandbox.mjs --destroy --all` purges and deletes buckets by\n" +
        "that marker, and the live suite uses it to tell a sandbox from a real vault. A vault\n" +
        "named this way is one command away from being deleted with its contents."
    );
  }
  return name;
}

/**
 * Points a parsed config at a named deployment. Everything else — compatibility date, the
 * Durable Object class and its migration tag, retention, the cron — stays exactly what
 * `wrangler.jsonc` says, so a second vault cannot quietly drift from the first.
 */
export function applyDeploymentName(config, name) {
  return { ...config, scriptName: name, bucket: name };
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
 *
 * `envFile` is which file those two values came from. A named deployment keeps its identity
 * in its own `.env.<name>`, and the guard must be comparing this deployment against ITSELF —
 * fed the default `.env`, every named deploy would look like a fork of production.
 */
export function assertNoRenameFork({
  scriptName,
  bucket,
  accountId,
  workerUrl = null,
  bucketOwned = null,
  allowRename = false,
  envFile = ".env",
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
        conflicts.push(
          `Worker: ${envFile} WORKER_URL is serving "${deployed}", config says "${scriptName}"`
        );
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
 * Refuses to upload a deployment over a Worker script this checkout has no record of.
 *
 * The bucket has an adoption guard; the script did not, and for a *named* deployment that is
 * a real gap. The name comes from the command line rather than from `wrangler.jsonc`, so on
 * the first deploy of a new vault there is nothing to compare against: `.env.<name>` does not
 * exist yet, so the fork guard has no evidence, and if the account has an unrelated Worker of
 * that name with no bucket to match, the bucket preflight succeeds too. The upload is a PUT —
 * it would replace that Worker's code and bindings, and the schedule call afterwards replaces
 * its cron.
 *
 * Recorded ownership costs no request: a deployment whose env file already names a URL was
 * put there by a previous successful deploy, and `assertNoRenameFork` has already checked
 * that URL against this script name. Only a first deploy pays for the lookup.
 *
 * `/settings` rather than the script itself: fetching the script returns JavaScript, and the
 * caller's `cf()` refuses a non-JSON body.
 */
export async function ensureWorkerScript(cf, scriptName, { owned = false, adopt = false } = {}) {
  if (owned) return { status: "owned" };
  if (adopt) return { status: "adopted" };

  const found = await cf(`/workers/scripts/${encodeURIComponent(scriptName)}/settings`);
  if (found.status === 404) return { status: "absent" };
  if (found.status !== 200) {
    throw new Error(
      `worker preflight failed with HTTP ${found.status}: ${JSON.stringify(found.body)}`
    );
  }
  throw new Error(
    `a Worker named "${scriptName}" already exists on this account and this checkout has no\n` +
      "record of deploying it. Uploading would REPLACE that Worker's code, its bindings and\n" +
      "its cron — whatever it currently is. If it really is a deployment of this vault whose\n" +
      "credentials file you lost, re-run with --adopt-worker; otherwise choose another name."
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
