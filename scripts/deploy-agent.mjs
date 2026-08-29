#!/usr/bin/env node
// Deploys the AGENT Worker (remote MCP server) via the Cloudflare REST API.
//
// Separate from deploy.mjs on purpose: this is a different script, with different secrets and
// a different blast radius. It holds the vault MASTER KEY, which the sync Worker never sees.
//
//   node scripts/deploy-agent.mjs --vault obsidian-agent-dummy
//   node scripts/deploy-agent.mjs --vault obsidian-agent-dummy --writable
//
// NEVER wrangler: the local wrangler login belongs to a different Cloudflare account. Account
// credentials come from .env; the target vault's identity comes from .env.<vault> alone.
//
// The agent's own identity lives in .env.agent.<vault>: its URL, its MCP bearer, and the ids
// of the access tokens it was issued (never the tokens themselves — those go to the Worker as
// secrets and are not recoverable afterwards, by design).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnvFile, localBin, upsertEnvFile, waitForHealth } from "./setup-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_DIR = path.join(ROOT, "agent");

const USAGE = `usage: node scripts/deploy-agent.mjs --vault <name> [--writable] [--rotate-bearer]

  --vault <name>     the vault this agent reads, deployed with setup.mjs --vault <name>
  --writable         also mint a sync-scoped token, enabling append/edit/write
  --rotate-bearer    issue a new MCP bearer even if one is already recorded
  --name <script>    agent Worker name (default: <vault>-agent)

The agent is a SEPARATE Worker holding the vault master key. Deploying it against a vault
whose own credentials are not in .env.<vault> is refused.`;

function parseArgs(argv) {
  const opts = { vault: null, writable: false, rotateBearer: false, name: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--vault") opts.vault = next();
    else if (arg === "--name") opts.name = next();
    else if (arg === "--writable") opts.writable = true;
    else if (arg === "--rotate-bearer") opts.rotateBearer = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown option "${arg}"\n\n${USAGE}`);
  }
  if (opts.vault === null) throw new Error(`--vault is required\n\n${USAGE}`);
  return opts;
}

const log = (m) => {
  console.log(m);
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const vault = opts.vault;
  const scriptName = opts.name ?? `${vault}-agent`;

  // --- credentials -----------------------------------------------------------
  const base = loadEnvFile(ROOT);
  const vaultEnvPath = path.join(ROOT, `.env.${vault}`);
  if (!existsSync(vaultEnvPath)) {
    throw new Error(
      `no .env.${vault} — stand the vault up first with:\n  node scripts/setup.mjs --token --vault ${vault}`
    );
  }
  const vaultEnv = loadEnvFile(ROOT, `.env.${vault}`);
  const TOKEN = process.env.CLOUDFLARE_TOKEN ?? vaultEnv.CLOUDFLARE_TOKEN ?? base.CLOUDFLARE_TOKEN;
  const ACCOUNT_ID =
    process.env.CLOUDFLARE_ACCOUNT_ID ?? vaultEnv.CLOUDFLARE_ACCOUNT_ID ?? base.CLOUDFLARE_ACCOUNT_ID;
  const SYNC_URL = vaultEnv.WORKER_URL;
  const ADMIN_TOKEN = vaultEnv.ADMIN_TOKEN;
  if (!TOKEN || !ACCOUNT_ID) throw new Error("CLOUDFLARE_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
  if (!SYNC_URL || !ADMIN_TOKEN) throw new Error(`.env.${vault} must hold WORKER_URL and ADMIN_TOKEN`);

  // The master key is the whole vault. It is never generated here and never written here:
  // it is read from the file the vault's own setup produced, and handed straight to the
  // Worker as a secret.
  const keyFile = path.join(ROOT, `testvault/${vault.replace(/^obsidian-/, "")}-master-key.txt`);
  const masterKey = (process.env.VAULT_MASTER_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, "utf8") : "")).trim();
  if (masterKey === "") {
    throw new Error(
      `no master key. Put it in VAULT_MASTER_KEY, or at ${path.relative(ROOT, keyFile)}.\n` +
        "Without it the agent can reach the vault but not read a single note."
    );
  }

  const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;
  const cf = async (pathname, init = {}) => {
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
  };
  const fail = (step, detail) => {
    throw new Error(`FAIL [${step}]: ${JSON.stringify(detail, null, 2)}`);
  };

  log(`agent "${scriptName}" for vault "${vault}" (${SYNC_URL})`);

  // --- refuse to upload over an unrelated Worker ------------------------------
  // The upload is a PUT: against a name somebody else owns it would replace that Worker's
  // code and bindings. A recorded URL from a previous deploy is proof this name is ours.
  const agentEnvName = `.env.agent.${vault}`;
  const agentEnv = existsSync(path.join(ROOT, agentEnvName)) ? loadEnvFile(ROOT, agentEnvName) : {};
  if (!agentEnv.AGENT_URL) {
    const existing = await cf(`/workers/scripts/${scriptName}/settings`);
    if (existing.status === 200) {
      throw new Error(
        `a Worker named "${scriptName}" already exists on this account, and ${agentEnvName} has no\n` +
          "record of this deployment. Uploading would replace that Worker's code and bindings.\n" +
          `Pick another name with --name, or delete the script first. Nothing was changed.`
      );
    }
  }

  // --- mint the vault access tokens -------------------------------------------
  const mint = async (name, scopes) => {
    const res = await fetch(`${SYNC_URL.replace(/\/$/, "")}/api/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ name, scopes }),
    });
    if (res.status !== 201) throw new Error(`minting "${name}" failed: ${res.status} ${await res.text()}`);
    return res.json();
  };

  log("minting a read-only vault token...");
  const readToken = await mint(`${scriptName}-read`, ["read"]);
  let writeToken = null;
  if (opts.writable) {
    // A SECOND token, not a widened one: read and write stay independently revocable, so a
    // capture credential can be withdrawn without blinding the agent.
    log("minting a separate sync-scoped token for writes...");
    writeToken = await mint(`${scriptName}-write`, ["sync"]);
  }

  const bearer =
    opts.rotateBearer || !agentEnv.MCP_BEARER ? randomBytes(32).toString("hex") : agentEnv.MCP_BEARER;

  // --- bundle ------------------------------------------------------------------
  log("bundling agent...");
  // esbuild's JS API through its resolved module path, never the `.bin` shim: that shim is a
  // `.cmd` on Windows and unspawnable without a shell. Same rule the sync deploy follows.
  const esbuild = await import(pathToFileURL(localBin(AGENT_DIR, "esbuild/lib/main.js")).href);
  const bundle = await esbuild.build({
    entryPoints: [path.join(AGENT_DIR, "src/index.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "neutral",
    minify: true,
    write: false,
    conditions: ["workerd", "worker", "browser"],
    // Runtime-provided, never bundled: `cloudflare:workers` is where the DurableObject base
    // class comes from and it exists only inside workerd.
    external: ["cloudflare:*"],
  });
  const bundled = bundle.outputFiles[0].text;
  log(`bundle: ${(Buffer.byteLength(bundled) / 1024).toFixed(1)} KiB`);

  // --- upload -------------------------------------------------------------------
  const metadataBase = {
    main_module: "worker.js",
    compatibility_date: "2026-08-03",
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: true, head_sampling_rate: 0.01 },
    bindings: [
      { type: "durable_object_namespace", name: "AGENT", class_name: "AgentState" },
      { type: "secret_text", name: "VAULT_MASTER_KEY", text: masterKey },
      { type: "secret_text", name: "SYNC_URL", text: SYNC_URL },
      { type: "secret_text", name: "SYNC_TOKEN", text: readToken.accessToken ?? readToken.token },
      { type: "secret_text", name: "MCP_BEARER", text: bearer },
      { type: "plain_text", name: "AGENT_DEVICE", text: `agent (${scriptName})` },
      // What the hard-skip set is computed from. A vault with a renamed Obsidian config folder
      // must say so, or its historical credentials are neither hidden nor write-protected.
      ...(process.env.VAULT_CONFIG_DIR
        ? [{ type: "plain_text", name: "VAULT_CONFIG_DIR", text: process.env.VAULT_CONFIG_DIR }]
        : []),
      ...(writeToken === null
        ? []
        : [
            {
              type: "secret_text",
              name: "SYNC_WRITE_TOKEN",
              text: writeToken.accessToken ?? writeToken.token,
            },
          ]),
    ],
  };

  const uploadScript = async (withMigrations) => {
    const metadata = withMigrations
      ? { ...metadataBase, migrations: { new_tag: "v1", new_sqlite_classes: ["AgentState"] } }
      : metadataBase;
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("worker.js", new Blob([bundled], { type: "application/javascript+module" }), "worker.js");
    return cf(`/workers/scripts/${scriptName}`, { method: "PUT", body: form });
  };

  log("uploading script...");
  let up = await uploadScript(true);
  if (up.status !== 200 && JSON.stringify(up.body ?? "").includes("migration")) {
    log("migration tag already applied, retrying without migrations...");
    up = await uploadScript(false);
  }
  if (up.status !== 200) fail("upload", up);
  log("script uploaded");

  const sub = await cf(`/workers/subdomain`);
  const subdomain = sub.body?.result?.subdomain;
  if (!subdomain) fail("subdomain", sub);

  const enable = await cf(`/workers/scripts/${scriptName}/subdomain`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
  });
  if (enable.status !== 200) fail("enable-subdomain", enable);

  const url = `https://${scriptName}.${subdomain}.workers.dev`;
  log(`smoke testing ${url}/health ...`);
  await waitForHealth({ workerUrl: url });

  upsertEnvFile(ROOT, {
    AGENT_URL: url,
    MCP_BEARER: bearer,
    VAULT_NAME: vault,
    READ_TOKEN_ID: readToken.tokenId ?? readToken.id ?? "",
    WRITE_TOKEN_ID: writeToken === null ? "" : (writeToken.tokenId ?? writeToken.id ?? ""),
  }, agentEnvName);

  log(`
agent live at ${url}
credentials recorded in ${agentEnvName} (gitignored)
tools: ${opts.writable ? "search, read, list, recent, append, edit, write" : "search, read, list, recent (read-only)"}

Add it in Claude → Settings → Connectors → Add custom connector:
  URL     ${url}/mcp
  Auth    None, plus a request header:
            Authorization: Bearer <MCP_BEARER from ${agentEnvName}>

The header value must include the word "Bearer" and the space — Claude sends it verbatim.`);
}

main().catch((error) => {
  console.error(`\ndeploy-agent failed: ${error.message}`);
  process.exit(1);
});
