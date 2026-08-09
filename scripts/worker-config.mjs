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
  };
}

export function loadWorkerDeployConfig(
  configPath = path.join(ROOT, "worker", "wrangler.jsonc")
) {
  return parseWorkerDeployConfig(readFileSync(configPath, "utf8"));
}

/** GET distinguishes an existing bucket from authorization/server failures before POST. */
export async function ensureR2Bucket(cf, bucket) {
  const pathName = `/r2/buckets/${encodeURIComponent(bucket)}`;
  const found = await cf(pathName);
  if (found.status === 200) return "existing";
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
  return "created";
}
