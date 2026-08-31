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

/** Lowercase RFC-4648 base32. 5 bytes → exactly 8 characters, all legal in a Worker name. */
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * A default agent script name that cannot be guessed from the vault's.
 *
 * The account subdomain is effectively public — every setup link and the sync URL itself name
 * it — so a fixed `<vault>-agent` is one guess away for anyone who has seen a sync URL, and
 * this is the endpoint fronting the vault master key. workers.dev sits behind a wildcard
 * certificate, so script names do not leak through Certificate Transparency either; the
 * hostname really is the only thing to guess.
 *
 * The **prefix stays** deliberately. Obscurity does nothing against an adversary who can
 * enumerate the account's Workers, because that adversary already owns the account — so the
 * readable prefix costs nothing against the real threat, while "which Worker holds a master
 * key" stays answerable at a glance in the dashboard.
 *
 * This is a layer on top of `MCP_BEARER`, never a replacement for it. The sync Worker keeps a
 * guessable name on purpose: it holds no key and fronts its own auth.
 */
export function randomAgentScriptName(vault, randomBytesImpl = randomBytes) {
  const bytes = randomBytesImpl(5);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `${vault}-agent-${out}`;
}

const USAGE = `usage: node scripts/deploy-agent.mjs --vault <name> [--writable] [--rotate-bearer]

  --vault <name>     the vault this agent reads, deployed with setup.mjs --vault <name>
  --writable         also mint a sync-scoped token, enabling append/edit/write
  --rotate-bearer    issue a new MCP bearer even if one is already recorded
  --name <script>    agent Worker name
                     (default: <vault>-agent-<8 random chars>, generated once and recorded
                      in .env.agent.<vault>; an existing deployment keeps its name)

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

/**
 * The connector setup text, in one place because two callers print it: this script run on its
 * own, and `deploy.mjs --agent`, which deploys the vault and its agent in one pass.
 *
 * The bearer itself is deliberately NOT interpolated. It is a credential to the process
 * holding the master key, and printing it would put it in terminal scrollback and in any
 * transcript of the deploy; the file it lives in is named instead.
 */
export function mcpSetupInstructions({ url, agentEnvName, writable }) {
  return `
agent live at ${url}
credentials recorded in ${agentEnvName} (gitignored)
tools: ${writable ? "search, read, list, recent, append, edit, write" : "search, read, list, recent (read-only)"}

Add it in Claude → Settings → Connectors → Add custom connector:
  URL     ${url}/mcp
  Auth    None, plus a request header:
            Authorization: Bearer <MCP_BEARER from ${agentEnvName}>

The header value must include the word "Bearer" and the space — Claude sends it verbatim.
The URL must end in /mcp, never /sse: Anthropic reads /sse as the legacy transport.
Register this workers.dev URL exactly — a redirect to another host drops the header.
Auth settings are immutable once the connector exists; rotating the bearer
(--rotate-bearer) means removing and re-adding it.

Health check: curl ${url}/health  →  {"ok":true}
An unauthenticated GET ${url}/mcp answers 401, not 405: the bearer is checked before
the method, so 401 there is the correct answer to an anonymous probe, not a broken deploy.`;
}

export async function deployAgent(opts) {
  const vault = opts.vault;

  // Read before the name is chosen: the name is generated once and then persisted, the way
  // MCP_BEARER is, so every redeploy lands on the same script rather than scattering a new
  // random Worker across the account each time.
  const agentEnvName = `.env.agent.${vault}`;
  const agentEnv = existsSync(path.join(ROOT, agentEnvName)) ? loadEnvFile(ROOT, agentEnvName) : {};

  // Order matters. An explicit --name wins; then the recorded name; then, for a deployment
  // made before names were randomised, the legacy `<vault>-agent` implied by a recorded URL —
  // without that fallback a redeploy of an existing agent would generate a fresh name and
  // stand up a SECOND Worker beside the live one, leaving the old one running with the key.
  // Only a genuinely new deployment gets a random suffix.
  const scriptName =
    opts.name ??
    agentEnv.AGENT_SCRIPT ??
    (agentEnv.AGENT_URL ? `${vault}-agent` : randomAgentScriptName(vault));

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
    // Recorded so redeploys reuse it. Renaming later is not an edit: it is a second Worker,
    // with its own empty Durable Object and a new connector URL, and the old script has to be
    // deleted by hand.
    AGENT_SCRIPT: scriptName,
    MCP_BEARER: bearer,
    VAULT_NAME: vault,
    READ_TOKEN_ID: readToken.tokenId ?? readToken.id ?? "",
    WRITE_TOKEN_ID: writeToken === null ? "" : (writeToken.tokenId ?? writeToken.id ?? ""),
  }, agentEnvName);

  return { url, agentEnvName, writable: opts.writable, scriptName, vault };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    const result = await deployAgent(parseArgs(process.argv.slice(2)));
    log(mcpSetupInstructions(result));
  } catch (error) {
    console.error(`\ndeploy-agent failed: ${error.message}`);
    process.exit(1);
  }
}
