#!/usr/bin/env node
// One command from a fresh clone to a working sync server.
//
//   node scripts/setup.mjs                 # picks the path from what is configured
//   node scripts/setup.mjs --wrangler      # deploy with the wrangler CLI login
//   node scripts/setup.mjs --token         # deploy with CLOUDFLARE_TOKEN (REST API)
//
// Every step is idempotent, so a re-run after a failure resumes rather than duplicates.
// EVERY run — first or re-run — ends by printing the server URL and a freshly issued
// access token: the two things that must be typed into the plugin. The admin credential
// that makes this possible is not the user's problem: it is reused from ./.env when it
// still matches the deployed secret, rotated otherwise (access tokens are unaffected),
// and written back to ./.env (gitignored) for the helper scripts. The vault master key is
// never involved — it is generated on the device and never touches this machine's disk.
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadWorkerDeployConfig } from "./worker-config.mjs";
import {
  ROOT,
  SETUP_USAGE,
  loadEnvFile,
  mintOrReplaceAccessToken,
  normalizeWorkerUrl,
  parseSetupArgs,
  tokenOutputPlan,
  writeTokenHandoff,
  parseWranglerAccount,
  renderSetupSummary,
  resolveAuthPath,
  upsertEnvFile,
  waitForHealth,
} from "./setup-lib.mjs";
// A SetupError from here carries a message meant for the user; the catch below prints it.
import { deployViaWrangler } from "./setup-wrangler.mjs";

const WORKER_DIR = path.join(ROOT, "worker");

function die(message) {
  console.error(`\nsetup failed: ${message}`);
  process.exit(1);
}

// The pinned devDependency, so setup deploys with the wrangler this repo was tested
// against instead of whatever `npx` resolves today.
const LOCAL_WRANGLER = path.join(WORKER_DIR, "node_modules", ".bin", "wrangler");

/** Runs wrangler and returns its output. `check: false` lets a caller inspect a failure. */
function wrangler(args, { input, check = true, quiet = false } = {}) {
  // Fails closed rather than falling back to `npx --yes wrangler@4`. That fallback would
  // download and execute whatever the registry currently serves for a mutable major-version
  // range — code handed the user's Cloudflare session, on the machine that deploys this
  // Worker — and it did it silently, so nobody could tell which wrangler had run.
  if (!existsSync(LOCAL_WRANGLER)) {
    die(
      "wrangler is not installed. Run `npm ci --prefix worker` and try again.\n" +
        "  Setup deliberately will not fetch it on the fly: the pinned devDependency is the\n" +
        "  only version this repo has been tested against, and it is the one that gets your\n" +
        "  Cloudflare credentials."
    );
  }
  const res = spawnSync(LOCAL_WRANGLER, args, {
    cwd: WORKER_DIR,
    input,
    encoding: "utf8",
    stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
  });
  if (res.error) die(`could not run wrangler: ${res.error.message}`);
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (!quiet && out.trim() !== "") console.log(out.trim());
  if (check && res.status !== 0) die(`wrangler ${args.join(" ")} exited ${res.status}`);
  return { status: res.status, out };
}

async function confirm(question) {
  if (!process.stdin.isTTY) {
    die(`${question} — no terminal to ask on. Re-run with --yes if that is what you want.`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// --- main --------------------------------------------------------------------

let opts;
try {
  opts = parseSetupArgs(process.argv.slice(2));
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
if (opts.help) {
  console.log(SETUP_USAGE);
  process.exit(0);
}

const config = loadWorkerDeployConfig();
const fileEnv = loadEnvFile(ROOT);
const hasToken = Boolean(process.env.CLOUDFLARE_TOKEN ?? fileEnv.CLOUDFLARE_TOKEN);
const hasAccountId = Boolean(process.env.CLOUDFLARE_ACCOUNT_ID ?? fileEnv.CLOUDFLARE_ACCOUNT_ID);

// Only ask wrangler about itself when it might actually be used: on a machine set up for
// the REST path, wrangler may be signed in elsewhere and is none of our business.
let account = null;
if (opts.requested === "wrangler" || (opts.requested === null && !hasToken)) {
  account = parseWranglerAccount(wrangler(["whoami"], { check: false, quiet: true }).out);
}

let auth;
try {
  auth = resolveAuthPath({ requested: opts.requested, hasToken, hasAccountId, wranglerAccount: account });
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
console.log(`\nDeploy path: ${auth.path} — ${auth.reason}\n`);

// Decided here, before the deploy and before any token is minted or replaced. Issuing runs
// through `mintOrReplaceAccessToken`, which REVOKES the previous token of that name — so
// discovering afterwards that stdout is unsafe would have destroyed a working credential and
// created a replacement the caller never receives. A token is returned exactly once.
const output = tokenOutputPlan({
  isTty: Boolean(process.stdout.isTTY),
  out: opts.out,
  printToken: opts.printToken,
});
if (output.kind === "refuse") {
  die(
    `${output.reason}\n` +
      "  Nothing was deployed and no token was changed."
  );
}

let deployment;
try {
  if (auth.path === "token") {
    const { deployViaRest } = await import("./deploy.mjs");
    // The same courtesy the wrangler path has always had: say which account, worker and
    // bucket are about to be provisioned, and let the user stop.
    deployment = await deployViaRest({
      adoptBucket: opts.adoptBucket,
      confirm: opts.assumeYes
        ? null
        : async (text) => {
            console.log(text);
            return confirm("Deploy to this target?");
          },
    });
  } else {
    deployment = await deployViaWrangler({
      config,
      assumeYes: opts.assumeYes,
      conflict: auth.conflict,
      account,
      storedAdminToken: (process.env.ADMIN_TOKEN ?? fileEnv.ADMIN_TOKEN)?.trim() || null,
      run: wrangler,
      confirm,
      randomHex: () => randomBytes(32).toString("hex"),
    });
  }
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}

const workerUrl = normalizeWorkerUrl(deployment.url);
if (auth.path === "wrangler") {
  console.log(`\nsmoke testing ${workerUrl}/health ...`);
  if (!(await waitForHealth({ workerUrl }))) {
    die(`${workerUrl}/health did not answer within 60s — the deploy may still be propagating`);
  }
}
console.log(`worker live at ${workerUrl}`);

// The admin credential is script-plumbing, not something the user stores: keep it in
// ./.env (gitignored) so access-token.mjs and the next setup run work with no copying.
// The bucket claim records that this checkout provisioned that storage. Without it the next
// REST run finds an existing, unclaimed bucket of the configured name and refuses to
// continue — the adoption guard firing on the very deploy that created it.
upsertEnvFile(ROOT, {
  WORKER_URL: workerUrl,
  ADMIN_TOKEN: deployment.adminToken,
  ...(deployment.bucketClaim ? { VAULT_BUCKET_OWNED: deployment.bucketClaim } : {}),
});
console.log(
  deployment.adminTokenKept
    ? "admin credential unchanged — ./.env refreshed (WORKER_URL, ADMIN_TOKEN)"
    : "admin credential rotated — ./.env updated (WORKER_URL, ADMIN_TOKEN)"
);

// Issue the access token — every run ends with one, because the deploy above always
// returns a working admin credential. Re-issuing replaces the token of the same name
// rather than stacking a second live one. A 401 right after the secret was rotated is
// usually propagation (old and new script versions serve side by side for a minute or
// two), so that one case retries briefly instead of failing the whole run.
let issued = null;
for (let attempt = 1; issued === null; attempt++) {
  try {
    issued = await mintOrReplaceAccessToken({
      workerUrl,
      adminToken: deployment.adminToken,
      name: opts.tokenName,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const transient = !deployment.adminTokenKept && /HTTP 401/.test(message);
    if (!transient || attempt >= 20) die(`could not issue the access token: ${message}`);
    console.log("rotated admin credential not accepted yet (deploy still propagating) — retrying...");
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

if (output.kind === "file") {
  const file = writeTokenHandoff(output.file, {
    workerUrl,
    accessToken: issued.minted.token,
    tokenId: issued.minted.id,
    tokenName: opts.tokenName,
  });
  console.log(`\nSetup complete. Access token written to ${file} (mode 0600), not printed here.`);
} else {
  console.log(
    renderSetupSummary({
      workerUrl,
      accessToken: issued.minted.token,
      tokenName: opts.tokenName,
    })
  );
}
