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
tools: ${writable ? "search, read, list, recent, append, edit, write, delete, move" : "search, read, list, recent (read-only)"}${
    writable
      ? "\nwrite, delete and move act like a file system: no confirmation, and your undo is\nsnapshot history within the retention window."
      : ""
  }

This Worker holds the vault MASTER KEY and decrypts notes to answer, so whatever it reads
reaches your model provider as plaintext. The sync Worker's "the server cannot read your
notes" property does not extend to it. Deleting this script and revoking its token ends it.

--- connect it -------------------------------------------------------------------------

FIRST, check this is possible: in Claude → Settings → Connectors → Add custom connector,
look for a "Request headers" section. Request headers are a gated beta. If that section is
absent, your account does not have it, bearer auth is unavailable, and there is currently no
other supported path — OAuth is not built. Nothing below will work until it appears.

  URL     ${url}/mcp
  Auth    None, plus a request header:
            Authorization: Bearer <MCP_BEARER from ${agentEnvName}>

Put the exact header value on your clipboard (it is not printed — this token fronts a
process holding the master key, and printing it would leave it in your scrollback):

  printf 'Bearer %s' "$(grep '^MCP_BEARER=' ${agentEnvName} | cut -d= -f2-)" | pbcopy

Four things that each cost an hour if missed:
  1. The value is sent verbatim, so it must include the word "Bearer" and the space.
  2. The URL must end in /mcp, never /sse — Anthropic reads /sse as the legacy transport.
  3. Register this workers.dev URL exactly; a redirect to another host drops the header.
  4. Auth settings are immutable once the connector exists, so rotating the bearer
     (--rotate-bearer) means removing and re-adding the connector.

--- check it ---------------------------------------------------------------------------

  curl ${url}/health          →  {"ok":true}
  node testvault/agent-mcp-verify.mjs   (50 checks against this live deployment)

An unauthenticated GET ${url}/mcp answers 401, not 405: the bearer is
checked before the method, so 401 there is the correct answer to an anonymous probe rather
than a broken deploy.

--- teach it your vault ----------------------------------------------------------------

Put a note called AGENT.md at the vault root — "daily notes live in Daily/YYYY-MM-DD.md",
"read Inbox.md first", "when I say log X, append X under ## Log in today's note" — and the
agent serves it as context at the start of every conversation. It is an ordinary note, so
you can edit it on any device${writable ? ", and this deployment can edit it itself" : ""}.
New text takes effect in the NEXT conversation. It is read through this vault's own exclude
policy, and it is advice to the model, never configuration.`;
}

/**
 * The zone the agent renders dates in, and resolves "1 August" and "last tuesday" against.
 *
 * Read from THIS machine when the vault does not name one, because the Worker runs in a colo
 * that has no idea where the vault lives — and the owner deploying is standing in the right
 * timezone by definition.
 *
 * A zone NAME, never an offset: `Intl` then applies the right offset per instant, so DST is
 * automatic and nothing in the agent knows a transition rule. An unknown name is refused here,
 * while a human is watching — the agent itself falls back to UTC rather than failing to start.
 */
export function resolveDeployZone(named, machine = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const zone = (named ?? "").trim() || machine || "UTC";
  const advice =
    'Use an IANA "Region/City" name such as "America/Los_Angeles" or "Asia/Tokyo".\n' +
    "A fixed offset cannot follow a DST transition; a zone name applies the right one per date.";
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
  } catch {
    throw new Error(`AGENT_TZ "${zone}" is not a timezone name this machine knows.\n${advice}`);
  }
  // ICU accepts the old abbreviations and resolves them somewhere surprising: "EST" is
  // America/PANAMA, which never observes DST, so a vault set to it would silently be an hour
  // out for eight months of the year. Refuse them rather than resolve them quietly.
  if (zone !== "UTC" && !zone.includes("/")) {
    const resolved = new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
    throw new Error(
      `AGENT_TZ "${zone}" is an abbreviation, not a zone — this machine reads it as "${resolved}".\n${advice}`
    );
  }
  return zone;
}

/**
 * The token ids a successful redeploy should retire: the pair this agent was using before.
 *
 * Filters out anything this run just minted, which is what makes a *first* deploy (no recorded
 * ids) and a re-run that somehow re-recorded the same id both no-ops rather than a deployment
 * that revokes its own live credentials. A read-only redeploy over a writable one retires the
 * write token too — that is the capability actually being withdrawn.
 */
export function supersededTokenIds(agentEnv, minted) {
  return [agentEnv.READ_TOKEN_ID, agentEnv.WRITE_TOKEN_ID].filter((id) => id && !minted.includes(id));
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
  const fromEnv = process.env.VAULT_MASTER_KEY !== undefined && process.env.VAULT_MASTER_KEY !== "";
  const keySource = fromEnv ? "VAULT_MASTER_KEY" : path.relative(ROOT, keyFile);
  const masterKey = (process.env.VAULT_MASTER_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, "utf8") : "")).trim();
  if (masterKey === "") {
    throw new Error(
      `no master key. Put it in VAULT_MASTER_KEY, or at ${path.relative(ROOT, keyFile)}.\n` +
        "Without it the agent can reach the vault but not read a single note."
    );
  }

  // Refused here rather than at the colo: a typo is a five-second fix while somebody is
  // watching, and an invisible silent fallback to UTC is a wrong date on every row for months.
  const timezone = resolveDeployZone(process.env.AGENT_TZ ?? vaultEnv.AGENT_TZ);

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
  // Which key, not the key. The wrong vault's key produces an agent that authenticates
  // perfectly and then decrypts nothing — a failure found much later, and confusing when it
  // arrives. Naming the source makes it checkable here, for free.
  log(`master key from ${keySource} (uploaded as a Worker secret; never printed)`);
  log(`timezone ${timezone}${process.env.AGENT_TZ ?? vaultEnv.AGENT_TZ ? "" : " (read from this machine)"}`);

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
  //
  // These are permanent, unexpiring credentials for the whole vault, so their lifetime is the
  // deployment's, not the process's. Two rules, and both are about what is *live* afterwards:
  //
  //   - a run that fails after minting revokes what it minted, so a broken deploy leaves no
  //     credential behind — least of all an untracked one, since the ids are only written to
  //     .env.agent.<vault> at the very end;
  //   - a run that succeeds revokes the pair it replaced, and only once the new deployment has
  //     answered /health. Revoking earlier would blind a working agent to save a failed one.
  const minted = [];
  const tokenIdOf = (token) => token.tokenId ?? token.id ?? "";

  const revoke = async (id) => {
    const res = await fetch(`${SYNC_URL.replace(/\/$/, "")}/api/tokens/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    // 404 is success by any definition that matters: the credential is not live.
    return res.status === 204 || res.status === 200 || res.status === 404;
  };

  const mint = async (name, scopes) => {
    const res = await fetch(`${SYNC_URL.replace(/\/$/, "")}/api/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ name, scopes }),
    });
    if (res.status !== 201) throw new Error(`minting "${name}" failed: ${res.status} ${await res.text()}`);
    const token = await res.json();
    minted.push(tokenIdOf(token));
    return token;
  };

  // Everything from the first mint to a healthy /health is one unit: if any of it throws, the
  // credentials this run created are revoked before the error is re-raised. Without that, a
  // deploy that fails at upload leaves a live vault token whose id was never written anywhere.
  let readToken;
  let writeToken = null;
  let bearer;
  let url;
  try {
    log("minting a read-only vault token...");
    readToken = await mint(`${scriptName}-read`, ["read"]);
    // (declared above, so the catch below can revoke it)
    if (opts.writable) {
      // A SECOND token, not a widened one: read and write stay independently revocable, so a
      // capture credential can be withdrawn without blinding the agent.
      log("minting a separate sync-scoped token for writes...");
      writeToken = await mint(`${scriptName}-write`, ["sync"]);
    }

    bearer =
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
        // Every date the agent renders, and every day boundary a range resolves to.
        { type: "plain_text", name: "AGENT_TZ", text: timezone },
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

    url = `https://${scriptName}.${subdomain}.workers.dev`;
    log(`smoke testing ${url}/health ...`);
    await waitForHealth({ workerUrl: url });
  } catch (error) {
    // Rollback, and loud about its own failure: an id that could not be revoked is the one
    // thing here an operator must act on by hand, and it is unrecoverable from any file.
    const stuck = [];
    for (const id of minted) {
      if (id === "") continue;
      const gone = await revoke(id).catch(() => false);
      if (!gone) stuck.push(id);
    }
    if (minted.length > 0) {
      log(
        stuck.length === 0
          ? `deploy failed — revoked the ${minted.length} token(s) this run created`
          : `deploy failed — COULD NOT REVOKE: ${stuck.join(", ")} — revoke by hand`
      );
    }
    throw error;
  }

  upsertEnvFile(ROOT, {
    AGENT_URL: url,
    // Recorded so redeploys reuse it. Renaming later is not an edit: it is a second Worker,
    // with its own empty Durable Object and a new connector URL, and the old script has to be
    // deleted by hand.
    AGENT_SCRIPT: scriptName,
    MCP_BEARER: bearer,
    VAULT_NAME: vault,
    READ_TOKEN_ID: tokenIdOf(readToken),
    WRITE_TOKEN_ID: writeToken === null ? "" : tokenIdOf(writeToken),
  }, agentEnvName);

  // --- retire the pair this deployment replaced --------------------------------
  //
  // Last, and deliberately: the new ids are already on disk, so a failure here costs a manual
  // revocation rather than an agent nobody can find the credentials for. Before /health passed
  // this would have been sabotage — the old token is what a working agent is still using.
  const superseded = supersededTokenIds(agentEnv, minted);
  const orphaned = [];
  for (const id of superseded) {
    const gone = await revoke(id).catch(() => false);
    if (!gone) orphaned.push(id);
  }
  if (superseded.length > 0) {
    log(
      orphaned.length === 0
        ? `revoked ${superseded.length} superseded vault token(s)`
        : `COULD NOT REVOKE superseded token(s): ${orphaned.join(", ")} — revoke by hand`
    );
  }

  return { url, agentEnvName, writable: opts.writable, scriptName, vault, keySource, orphaned };
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
