#!/usr/bin/env node
// Stands up (and tears down) the THROWAWAY per-file store Worker the benchmark's comparator
// runs against (plan.md, 2026-08-15).
//
// The comparator replays remotely-save's S3 protocol — full LIST every pass, one request per
// file — and needs an object store on the SAME account, colo and R2 as the sync sandbox, or
// the comparison measures networks instead of protocols. So this mirrors scripts/sandbox.mjs:
// wrangler, sandbox account only, `-sandbox` marker in every name, purge-then-delete teardown.
//
//   node scripts/bench-naive.mjs             # deploy
//   node scripts/bench-naive.mjs --destroy   # purge bucket, delete Worker and bucket
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile, localBin, waitForHealth } from "./setup-lib.mjs";
import { loadWorkerDeployConfig } from "./worker-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = path.join(ROOT, "worker");
const VAULT_DIR = path.join(ROOT, "testvault");
const ENV_FILE = path.join(VAULT_DIR, ".env.sandbox-naive");
const SUFFIX = "sandbox-naive";

// The pinned devDependency under the current Node, not `npx` — `npx` is a `.cmd` on Windows
// (unspawnable without a shell) and resolves to whatever the registry serves today, on the
// path that can `--destroy` a bucket. Same rule as sandbox.mjs and CLAUDE.md.
const LOCAL_WRANGLER = localBin(WORKER_DIR, "wrangler/bin/wrangler.js");

function wrangler(args, { input } = {}) {
  const run = spawnSync(process.execPath, [LOCAL_WRANGLER, ...args], {
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

/** Same guard as sandbox.mjs: refuse to act if the wrangler login IS the production account. */
function assertSandboxAccount() {
  const whoami = execFileSync(process.execPath, [LOCAL_WRANGLER, "whoami"], {
    cwd: WORKER_DIR,
    encoding: "utf8",
  });
  const id = /\b([0-9a-f]{32})\b/.exec(whoami)?.[1] ?? null;
  if (id === null) throw new Error(`could not read an account id from wrangler whoami:\n${whoami}`);
  const production = (process.env.CLOUDFLARE_ACCOUNT_ID ?? loadEnvFile(ROOT).CLOUDFLARE_ACCOUNT_ID)?.trim();
  if (production && production === id) {
    throw new Error(
      "refusing to run: the wrangler login is the PRODUCTION account.\n" +
        "This script deploys throwaway Workers and deletes buckets. Nothing was changed."
    );
  }
  return id;
}

function withFile(full, contents, run) {
  writeFileSync(full, contents);
  try {
    return run();
  } finally {
    rmSync(full, { force: true });
  }
}

/**
 * The store itself: PUT/GET/DELETE one object per file plus a paged LIST — the surface an
 * S3-style sync plugin uses, and nothing else. `/health` is unauthenticated so deploy can wait
 * for routability the way sandbox.mjs does.
 */
function storeScript(secret) {
  return `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (request.headers.get("authorization") !== ${JSON.stringify(`Bearer ${secret}`)}) {
      return new Response("forbidden", { status: 403 });
    }
    if (url.pathname === "/list") {
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const page = await env.VAULT.list({ cursor, limit: 1000 });
      return Response.json({
        objects: page.objects.map((o) => ({ key: o.key, size: o.size })),
        cursor: page.truncated ? page.cursor : null,
      });
    }
    if (url.pathname.startsWith("/o/")) {
      const key = decodeURIComponent(url.pathname.slice(3));
      if (key === "") return new Response("empty key", { status: 400 });
      if (request.method === "PUT") {
        await env.VAULT.put(key, request.body);
        return Response.json({ ok: true });
      }
      if (request.method === "DELETE") {
        await env.VAULT.delete(key);
        return Response.json({ ok: true });
      }
      if (request.method === "GET") {
        const object = await env.VAULT.get(key);
        if (object === null) return new Response("missing", { status: 404 });
        return new Response(object.body);
      }
    }
    return new Response("bad request", { status: 400 });
  },
};
`;
}

async function deploy() {
  const base = loadWorkerDeployConfig();
  const accountId = assertSandboxAccount();
  const name = `${base.scriptName}-${SUFFIX}`;
  const bucket = name;
  console.log(`sandbox account ${accountId.slice(0, 8)}…, naive store "${name}"`);

  const created = wrangler(["r2", "bucket", "create", bucket]);
  console.log(`bucket ${bucket}: ${/already exists/i.test(created) ? "existing" : "created"}`);

  const token = randomBytes(32).toString("hex");
  const scriptFile = path.join(WORKER_DIR, ".bench-naive.mjs");
  const out = withFile(scriptFile, storeScript(token), () =>
    withFile(
      path.join(WORKER_DIR, ".bench-naive.jsonc"),
      JSON.stringify(
        {
          name,
          main: path.basename(scriptFile),
          compatibility_date: base.compatibilityDate,
          r2_buckets: [{ binding: "VAULT", bucket_name: bucket }],
        },
        null,
        2
      ),
      () => wrangler(["deploy", "-c", ".bench-naive.jsonc"])
    )
  );
  const url = workersDevUrl(out);
  if (url === null) throw new Error(`no workers.dev URL in the deploy output:\n${out}`);
  await waitForHealth(url);

  mkdirSync(VAULT_DIR, { recursive: true });
  writeFileSync(
    ENV_FILE,
    [
      "# Throwaway naive-store credentials for the timing benchmark. Not production.",
      "# Regenerate with `node scripts/bench-naive.mjs`; revoke with `--destroy`.",
      `R2DO_NAIVE_URL=${url}`,
      `R2DO_NAIVE_TOKEN=${token}`,
      "",
    ].join("\n"),
    { mode: 0o600 }
  );
  console.log(`wrote ${path.relative(ROOT, ENV_FILE)} (mode 600)\n\nNAIVE STORE READY: ${url}`);
}

/** Same shape as sandbox.mjs teardown: empty the bucket through a bound Worker, then delete both. */
async function destroy() {
  const base = loadWorkerDeployConfig();
  assertSandboxAccount();
  const name = `${base.scriptName}-${SUFFIX}`;
  const bucket = name;
  console.log(`tearing down "${name}"`);

  const secret = randomBytes(16).toString("hex");
  const purge = `export default {
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
  const purgeName = `${name}-purge`;
  const scriptFile = path.join(WORKER_DIR, ".bench-naive-purge.mjs");
  const out = withFile(scriptFile, purge, () =>
    withFile(
      path.join(WORKER_DIR, ".bench-naive-purge.jsonc"),
      JSON.stringify(
        {
          name: purgeName,
          main: path.basename(scriptFile),
          compatibility_date: base.compatibilityDate,
          r2_buckets: [{ binding: "VAULT", bucket_name: bucket }],
        },
        null,
        2
      ),
      () => wrangler(["deploy", "-c", ".bench-naive-purge.jsonc"])
    )
  );
  const url = workersDevUrl(out);
  if (url === null) throw new Error(`purge worker did not report a URL:\n${out}`);

  let report = null;
  for (let attempt = 0; attempt < 25 && report === null; attempt += 1) {
    const res = await fetch(`${url}/?k=${secret}`);
    if (res.ok) report = await res.json();
    else await new Promise((r) => setTimeout(r, 1000));
  }
  if (report === null) throw new Error(`purge worker never answered — ${bucket} not emptied, nothing deleted`);
  console.log(`purged ${report.deleted} object(s) from ${bucket}`);
  wrangler(["delete", "--name", purgeName, "--force"]);
  wrangler(["delete", "--name", name, "--force"]);
  wrangler(["r2", "bucket", "delete", bucket]);
  rmSync(ENV_FILE, { force: true });
  console.log(`deleted Worker ${name} and bucket ${bucket}\n\nNAIVE STORE DESTROYED`);
}

const argv = process.argv.slice(2);
const unknown = argv.find((a) => a !== "--destroy");
if (unknown) {
  console.error(`unknown option "${unknown}"\n\nusage: node scripts/bench-naive.mjs [--destroy]`);
  process.exit(1);
}

try {
  if (argv.includes("--destroy")) await destroy();
  else await deploy();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
