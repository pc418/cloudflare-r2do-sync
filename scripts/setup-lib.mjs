// Pieces shared by scripts/setup.mjs, scripts/deploy.mjs and scripts/access-token.mjs.
//
// Everything here is either pure or takes its `fetch` as an argument, so the parts that
// decide *what* setup does (which credentials, which words the user is told) are unit
// tested without touching a Cloudflare account.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const WIDE = "═".repeat(72);
const THIN = "─".repeat(72);

/**
 * Path to a locally installed CLI's own JS entrypoint, to be run as
 * `spawnSync(process.execPath, [localBin(dir, …), ...args])` — never the `node_modules/.bin`
 * shim, and never through a shell.
 *
 * On Windows npm writes the shim as `wrangler.cmd`; the extensionless `.bin/wrangler` is an
 * sh script, so spawning it fails with ENOENT (reported as issue #9). Naming the `.cmd`
 * instead does not help either: since CVE-2024-27980 Node refuses to spawn a `.cmd`/`.bat`
 * without `shell: true`, and `shell: true` would hand every argument to cmd.exe to re-parse —
 * bucket names, worker names and account ids on the same command line as a Cloudflare admin
 * credential. Running the entrypoint under the current Node needs no shell on any platform,
 * so no argument is ever reinterpreted.
 */
export function localBin(dir, entry) {
  return path.join(dir, "node_modules", ...entry.split("/"));
}

/**
 * How the user is told to run wrangler themselves. Spelled as a `node` invocation of the
 * pinned devDependency for the same reason `localBin` exists: `./worker/node_modules/.bin/…`
 * is not a runnable path in cmd.exe or PowerShell, and `npx wrangler` would resolve to
 * whatever the registry serves today rather than the version this repo was tested against.
 */
export const WRANGLER_CMD = "node worker/node_modules/wrangler/bin/wrangler.js";

/**
 * Splits a config file into lines regardless of who wrote it. A `.env` created on Windows
 * has CRLF endings, and a bare `split("\n")` leaves `\r` on the end of every line — which
 * `loadEnvFile`'s `$`-anchored regex cannot match at all (`.` does not match `\r`), so the
 * file parses to nothing at all rather than to slightly wrong values.
 */
const splitLines = (text) => text.split(/\r?\n/);

/** `.env` values, if the file exists. Real environment variables take precedence. */
export function loadEnvFile(root = ROOT) {
  const out = {};
  try {
    for (const line of splitLines(readFileSync(path.join(root, ".env"), "utf8"))) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
    // No .env: everything must then come from the environment, checked by callers.
  }
  return out;
}

/**
 * Writes `values` into `root`/.env, replacing existing assignments in place and appending
 * the rest. Every other line — comments, unrelated keys — is preserved verbatim: this file
 * also carries the user's Cloudflare credentials, which setup must never touch.
 *
 * This is how the admin credential stays out of the user's hands entirely: setup stores
 * what the helper scripts need, and nobody has to copy secrets anywhere.
 */
export function upsertEnvFile(root, values) {
  const file = path.join(root, ".env");
  const lines = existsSync(file) ? splitLines(readFileSync(file, "utf8")) : [];
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

  const pending = new Map(Object.entries(values));
  const updated = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    if (!m || !pending.has(m[1])) return line;
    const next = `${m[1]}=${pending.get(m[1])}`;
    pending.delete(m[1]);
    return next;
  });
  for (const [key, value] of pending) updated.push(`${key}=${value}`);

  writeFileSync(file, `${updated.join("\n")}\n`, { mode: 0o600 });
  // `mode:` only applies when the file is CREATED. An .env that already existed keeps
  // whatever permissions it had — commonly 0644 from an editor or a `cp .env.example` — and
  // this function has just written an admin token and a vault-wide access token into it.
  chmodSync(file, 0o600);
  return file;
}

function isLoopbackHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host === "::1") return true;
  const octets = host.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** Normalizes a credential-bearing endpoint and refuses plaintext transport off loopback. */
export function normalizeWorkerUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    throw new Error("WORKER_URL must be a valid http(s) URL");
  }
  if (parsed.username || parsed.password) throw new Error("WORKER_URL must not contain credentials");
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("WORKER_URL must be http(s)");
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error("WORKER_URL must use HTTPS (HTTP is allowed only for explicit loopback hosts)");
  }
  return parsed.toString().replace(/\/+$/, "");
}

export const SETUP_USAGE = `usage: node scripts/setup.mjs [options]

  --wrangler         deploy with the wrangler CLI (its own login decides the account)
  --token            deploy with the Cloudflare REST API (CLOUDFLARE_TOKEN + CLOUDFLARE_ACCOUNT_ID)
  --name <label>     label for the access token (default: vault)
  --out <file>       write the access token to a 0600 JSON file instead of printing it
  --print-token      print the token even when stdout is not a terminal
  --adopt-bucket     use an existing R2 bucket of the configured name (REST path)
  --yes              do not prompt for confirmation (the target account is still printed)
  --help

With neither --wrangler nor --token the path is chosen from what is configured, and the
choice is always announced before anything is created. Setup never logs wrangler in or
out — it reads who you are and stops if that is not who you want.`;

export function parseSetupArgs(argv) {
  const opts = {
    requested: null,
    tokenName: "vault",
    assumeYes: false,
    help: false,
    out: null,
    printToken: false,
    adoptBucket: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--wrangler" || arg === "--token") {
      const requested = arg.slice(2);
      if (opts.requested && opts.requested !== requested) {
        throw new Error("--wrangler and --token are mutually exclusive");
      }
      opts.requested = requested;
    } else if (arg === "--name") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--name needs a value");
      opts.tokenName = value;
    } else if (arg === "--out") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--out needs a file path");
      opts.out = value;
    } else if (arg === "--print-token") {
      opts.printToken = true;
    } else if (arg === "--adopt-bucket") {
      opts.adoptBucket = true;
    } else if (arg === "--yes" || arg === "-y") {
      opts.assumeYes = true;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      throw new Error(`unknown option "${arg}"\n\n${SETUP_USAGE}`);
    }
  }
  return opts;
}

/**
 * Decides which credentials deploy the worker.
 *
 * The two paths write to *different Cloudflare accounts* whenever both are configured, so
 * this never picks silently in that case: an explicit --wrangler alongside a configured
 * REST token is reported as a conflict for the caller to confirm, and a half-configured
 * REST setup is an error rather than a quiet downgrade to wrangler.
 */
export function resolveAuthPath({ requested, hasToken, hasAccountId, wranglerAccount }) {
  if (requested === "token") {
    if (!hasToken || !hasAccountId) {
      throw new Error(
        `--token needs ${!hasToken ? "CLOUDFLARE_TOKEN" : "CLOUDFLARE_ACCOUNT_ID"} in .env or the environment (see .env.example)`
      );
    }
    return { path: "token", needsLogin: false, conflict: false, reason: "--token was requested" };
  }

  if (requested === "wrangler") {
    return {
      path: "wrangler",
      needsLogin: !wranglerAccount,
      conflict: hasToken,
      reason: "--wrangler was requested",
    };
  }

  if (hasToken && hasAccountId) {
    return {
      path: "token",
      needsLogin: false,
      conflict: false,
      reason: "CLOUDFLARE_TOKEN and CLOUDFLARE_ACCOUNT_ID are configured, so the REST API path is used",
    };
  }
  if (hasToken) {
    throw new Error(
      "CLOUDFLARE_TOKEN is set but CLOUDFLARE_ACCOUNT_ID is not.\n" +
        "Add the account id (dashboard → Workers & Pages → Account ID), or pass --wrangler\n" +
        "to deploy with the wrangler login instead — that may be a different account."
    );
  }
  if (wranglerAccount) {
    return {
      path: "wrangler",
      needsLogin: false,
      conflict: false,
      reason: `wrangler is logged in as ${wranglerAccount}`,
    };
  }
  return {
    path: "wrangler",
    needsLogin: true,
    conflict: false,
    reason: `nothing is configured yet — log in with \`${WRANGLER_CMD} login\`, or set CLOUDFLARE_TOKEN`,
  };
}

/**
 * What the wrangler path shows before it creates anything.
 *
 * `wrangler login` persists, so the CLI is frequently signed in to some *other* account
 * from earlier work — and a wrong answer here silently provisions a worker, a bucket and a
 * vault in a stranger's-to-you account. So the account is always named out loud, with the
 * way out printed next to it. Setup never changes the login itself: whose credentials get
 * used is the user's call, made with their own hands.
 */
export function renderAccountCheck({ account, scriptName, bucket, conflict = false }) {
  const lines = [
    "",
    THIN,
    "  wrangler will deploy to THIS Cloudflare account",
    THIN,
    `    account   ${account ?? "(not logged in)"}`,
    `    worker    ${scriptName}`,
    `    R2 bucket ${bucket}`,
    "",
  ];
  lines.push(
    account
      ? "  Wrong account? Switch it yourself, then re-run setup:"
      : "  Log in first, then re-run setup:",
    account
      ? `      ${WRANGLER_CMD} logout && ${WRANGLER_CMD} login`
      : `      ${WRANGLER_CMD} login`,
    ""
  );
  if (conflict) {
    lines.push(
      "  NOTE: CLOUDFLARE_TOKEN is configured in .env, which points at a possibly",
      "  DIFFERENT account. You asked for --wrangler, so the token is ignored.",
      ""
    );
  }
  return lines.join("\n");
}

/** `wrangler whoami` prints a table; pull out something a human can recognise. */
export function parseWranglerAccount(stdout) {
  if (typeof stdout !== "string" || stdout === "") return null;
  if (/not authenticated|you are not logged in/i.test(stdout)) return null;
  const email = stdout.match(/associated with the email\s+([^\s.]+@[^\s.]+\.\S+?)[.!]?\s*$/im)?.[1];
  const row = stdout.match(/^\s*[│|]\s*(.+?)\s*[│|]\s*([0-9a-f]{32})\s*[│|]\s*$/im);
  const account = row ? `${row[1].trim()} (${row[2]})` : null;
  if (email && account) return `${email} — ${account}`;
  return email ?? account;
}

// --- admin API ---------------------------------------------------------------
// The admin token mints and revokes access tokens. It never decrypts anything: the vault
// master key lives only on the devices.

async function adminFetch(fetchImpl, workerUrl, adminToken, pathname, init = {}) {
  return fetchImpl(`${workerUrl}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${adminToken}`, ...(init.headers ?? {}) },
  });
}

/**
 * True when the worker's admin API accepts `adminToken`.
 *
 * A secret can never be read back, so on a redeploy the only way to know whether the
 * stored copy still matches is to try it. 401/403 is a definitive "no" (the caller then
 * rotates the secret); any other failure throws, because rotating would not fix it.
 */
export async function verifyAdminToken({ workerUrl, adminToken, fetchImpl = fetch }) {
  const res = await adminFetch(fetchImpl, workerUrl, adminToken, "/api/tokens");
  if (res.status === 200) return true;
  if (res.status === 401 || res.status === 403) return false;
  throw new Error(`admin token check failed: HTTP ${res.status} ${await res.text()}`);
}

export async function mintAccessToken({ workerUrl, adminToken, name, fetchImpl = fetch }) {
  const res = await adminFetch(fetchImpl, workerUrl, adminToken, "/api/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res.status !== 201) throw new Error(`mint failed: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

export async function listAccessTokens({ workerUrl, adminToken, fetchImpl = fetch }) {
  const res = await adminFetch(fetchImpl, workerUrl, adminToken, "/api/tokens");
  if (res.status !== 200) throw new Error(`list failed: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (!Array.isArray(body?.tokens)) throw new Error("list failed: response has no tokens array");
  return body.tokens;
}

export async function revokeAccessToken({ workerUrl, adminToken, id, fetchImpl = fetch }) {
  const res = await adminFetch(fetchImpl, workerUrl, adminToken, `/api/tokens/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (res.status !== 204) throw new Error(`revoke ${id} failed: HTTP ${res.status} ${await res.text()}`);
}

/**
 * Mints a token, then revokes the active ones `shouldRevoke` selects.
 *
 * The listing is taken *before* minting, so the new token can never be caught by its own
 * cleanup — and revoking happens after the replacement exists, so a failure part-way leaves
 * the user with a working token rather than none.
 */
async function mintAndRevoke({ workerUrl, adminToken, name, fetchImpl, shouldRevoke }) {
  const before = await listAccessTokens({ workerUrl, adminToken, fetchImpl });
  const minted = await mintAccessToken({ workerUrl, adminToken, name, fetchImpl });
  const revoked = [];
  for (const device of before) {
    if (device.id === minted.id || !shouldRevoke(device)) continue;
    await revokeAccessToken({ workerUrl, adminToken, id: device.id, fetchImpl });
    revoked.push(device);
  }
  return { minted, revoked };
}

/**
 * Mints a replacement token and revokes every other active one.
 *
 * Revoking immediately is the point: rotation means the old token is no longer trusted, so
 * the devices still holding it must fail loudly rather than keep syncing until someone
 * remembers to finish the job.
 */
export async function rotateAccessToken({ workerUrl, adminToken, name = "vault", fetchImpl = fetch }) {
  return mintAndRevoke({ workerUrl, adminToken, name, fetchImpl, shouldRevoke: () => true });
}

/**
 * Mints `name`, replacing any active token that already carries that name.
 *
 * Running the mint command twice must not leave two live tokens called "vault": nothing
 * distinguishes them afterwards, so a later revoke becomes a coin flip. Re-minting a name
 * therefore means "this name should now be this token" — and because it only touches that
 * name, an unrelated named access token (for example, "phone") keeps working.
 */
export async function mintOrReplaceAccessToken({ workerUrl, adminToken, name, fetchImpl = fetch }) {
  return mintAndRevoke({
    workerUrl,
    adminToken,
    name,
    fetchImpl,
    shouldRevoke: (device) => device.name === name,
  });
}

/** Polls `/health` until the new deployment answers, so setup never prints a dead URL. */
export async function waitForHealth({
  workerUrl,
  fetchImpl = fetch,
  attempts = 20,
  delayMs = 3000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(`${workerUrl}/health`);
      if (res.status === 200 && (await res.json())?.ok === true) return true;
    } catch {
      // DNS or deployment propagation is not ready yet.
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return false;
}

/**
 * The REST path's equivalent of the wrangler account check: name the account, script and
 * bucket before anything is provisioned. Only the first 8 characters of the account id are
 * shown — enough to tell two accounts apart on sight, without writing the whole identifier
 * into a terminal transcript.
 */
export function renderRestDeployCheck({ accountId, scriptName, bucket, bucketOwned, retention }) {
  return [
    "",
    THIN,
    "  DEPLOY TARGET (Cloudflare REST API)",
    THIN,
    `  Account    ${String(accountId).slice(0, 8)}… (from CLOUDFLARE_ACCOUNT_ID)`,
    `  Worker     ${scriptName}`,
    `  R2 bucket  ${bucket}${bucketOwned ? " (created by this checkout)" : ""}`,
    // Retention is the one deploy-time setting that decides what gets deleted, so it belongs
    // on the same screen as the bucket it deletes from.
    ...(retention
      ? [`  Retention  ${retention.GC_KEEP_DAYS} day(s), and at least the newest ${retention.GC_KEEP_COUNT} snapshot(s)`]
      : []),
    "",
    bucketOwned
      ? "  This is a redeploy onto storage this checkout provisioned."
      : "  If that bucket already exists on this account, setup will stop rather than adopt it.",
    "",
  ].join("\n");
}

// --- token handoff ------------------------------------------------------------

/**
 * Where a freshly minted access token may be written.
 *
 * A token is returned exactly once, so this has to be decided BEFORE minting: refusing
 * afterwards would throw away a credential that can no longer be recovered. On a terminal,
 * printing is what the user asked for. Without one — a CI job, a pipe into a log file, an
 * agent capturing stdout — a vault-wide bearer token would be written somewhere nobody
 * chose, and it authenticates read, write and history destruction for the whole vault. So
 * that case must say so explicitly, either with `--print-token` or by naming a 0600 file.
 */
export function tokenOutputPlan({ isTty, out = null, printToken = false }) {
  if (out) return { kind: "file", file: out };
  if (printToken) return { kind: "stdout" };
  if (isTty) return { kind: "stdout" };
  return {
    kind: "refuse",
    reason:
      "refusing to print a vault-wide access token to a non-terminal: it would land in a log\n" +
      "or CI transcript. Re-run with --out <file> to write it to a 0600 file, or\n" +
      "--print-token if stdout really is where you want it.",
  };
}

/** Writes the handoff a non-interactive caller asked for, readable only by its owner. */
export function writeTokenHandoff(file, payload) {
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600); // `mode:` only applies on creation; the file may already exist
  return file;
}

// --- final output ------------------------------------------------------------

/**
 * The last thing setup prints: everything the user must carry into Obsidian, and nothing
 * else. There is deliberately no admin-token section — that credential is managed
 * automatically in ./.env, so a person never stores, types, or rotates it by hand.
 */
export function renderSetupSummary({ workerUrl, accessToken, tokenName = "vault" }) {
  if (!accessToken) {
    // Setup always ends holding a working admin credential (reused or rotated), so an
    // absent access token is a bug in the caller, not a state to explain to the user.
    throw new Error("renderSetupSummary needs an access token — setup always issues one");
  }
  return [
    "",
    WIDE,
    "  PASTE THESE INTO OBSIDIAN",
    WIDE,
    "",
    `  Server URL   ${workerUrl}`,
    `  Access token ${accessToken}`,
    "",
    `  (labelled "${tokenName}", shown once — re-run setup any time for a fresh one)`,
    "",
    "  Next steps",
    "    1. Build and install the plugin (the `cd ..` matters — the second command is",
    "       run from the repository root):",
    "         cd plugin && node build.mjs && cd ..",
    '         node scripts/install-plugin.mjs "/path/to/Your Vault"',
    '    2. Obsidian → Settings → Community plugins → enable "R2DO Sync".',
    '    3. In the plugin settings fill in "Server URL" and "Access token" from above,',
    '       and set "Device name" (the name is what labels conflict copies).',
    "    4. The vault master key is generated for you and a window asks you to save it.",
    '       Copy it into a password manager and press "I saved it" — sync stays disabled',
    '       until you do. Then press "Sync now".',
    '    5. For each further device: "Set up another device" here, then either show the',
    "       QR and scan it with that device's camera, or copy the setup link and paste",
    "       it there. Do this BEFORE its first sync — the payload carries the master",
    "       key, and without the key the vault is unreadable and sync stops.",
    "",
    "  The master key never leaves your devices and is not stored on the server or",
    "  in this repo. If you lose every device that has it, the backup is unreadable.",
    "",
    THIN,
    "  GOOD TO KNOW (nothing to do here)",
    THIN,
    "",
    "  A server admin secret (ADMIN_TOKEN) was saved to ./.env next to the server",
    "  URL. It lets the scripts in this repo issue and revoke access tokens — it",
    "  cannot read your notes. You will most likely never touch it: .env is",
    "  gitignored, and if it is ever lost or wrong, re-running setup fixes it.",
    "",
    "  Lost a device:        node scripts/access-token.mjs --rotate   (revokes the rest)",
    "  Just need the token:  node scripts/access-token.mjs            (or re-run setup)",
    WIDE,
    "",
  ].join("\n");
}
