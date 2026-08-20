import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ROOT,
  deploymentEnvFile,
  loadEnvFile,
  localBin,
  parseSetupArgs,
  resolveDeploymentEnv,
  resolveDeploymentRequest,
  parseWranglerAccount,
  tokenOutputPlan,
  writeTokenHandoff,
  renderRestDeployCheck,
  renderAccountCheck,
  renderSetupSummary,
  resolveAuthPath,
  mintOrReplaceAccessToken,
  rotateAccessToken,
  upsertEnvFile,
  verifyAdminToken,
  waitForHealth,
} from "./setup-lib.mjs";

// --- token handoff -----------------------------------------------------------

test("a terminal prints the token; a pipe refuses unless told where to put it", () => {
  // The credential is vault-wide and returned exactly once, so the refusal has to be
  // available BEFORE minting — which is why this is a pure decision, not a print guard.
  assert.equal(tokenOutputPlan({ isTty: true }).kind, "stdout");
  assert.equal(tokenOutputPlan({ isTty: false }).kind, "refuse");
  assert.match(tokenOutputPlan({ isTty: false }).reason, /--out/);
  assert.equal(tokenOutputPlan({ isTty: false, printToken: true }).kind, "stdout");

  const explicit = tokenOutputPlan({ isTty: false, out: "tok.json" });
  assert.equal(explicit.kind, "file");
  assert.equal(explicit.file, "tok.json");
  // An explicit file wins even on a terminal: automation asked for a file, not a screen.
  assert.equal(tokenOutputPlan({ isTty: true, out: "tok.json" }).kind, "file");
});

test("the token handoff file is written owner-only, even over a permissive existing file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "setup-lib-tok-"));
  const file = path.join(root, "token.json");
  writeFileSync(file, "{}\n");
  chmodSync(file, 0o644);

  writeTokenHandoff(file, { workerUrl: "https://x.test", accessToken: "secret-token" });

  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).accessToken, "secret-token");
});

test("setup decides where the token may go before it mutates anything", () => {
  // Ordering, not wording. `mintOrReplaceAccessToken` REVOKES the previous token of that
  // name, and a token is returned exactly once — so learning after the fact that stdout is a
  // CI log would have destroyed a working credential and issued a replacement into a void.
  const source = readFileSync(path.join(ROOT, "scripts", "setup.mjs"), "utf8");
  const decides = source.indexOf("tokenOutputPlan({");
  const deploys = source.indexOf("deployViaRest({");
  const mints = source.indexOf("mintOrReplaceAccessToken({");

  assert.ok(decides > 0 && deploys > 0 && mints > 0, "expected all three call sites");
  assert.ok(decides < deploys, "output eligibility must be decided before deploying");
  assert.ok(decides < mints, "output eligibility must be decided before minting a token");
});

test("a REST setup records the bucket it provisioned, so the next run is not blocked", () => {
  // deployViaRest() returns the claim; dropping it makes the adoption guard fire on the very
  // deploy that created the bucket.
  const source = readFileSync(path.join(ROOT, "scripts", "setup.mjs"), "utf8");
  assert.match(source, /VAULT_BUCKET_OWNED: deployment\.bucketClaim/);
});

// --- argument parsing --------------------------------------------------------

test("setup args default to auto-detected auth and the shared token name", () => {
  assert.deepEqual(parseSetupArgs([]), {
    requested: null,
    tokenName: "vault",
    assumeYes: false,
    help: false,
    out: null,
    printToken: false,
    adoptBucket: false,
    adoptWorker: false,
    vault: null,
  });
});

test("setup args carry the explicit choices", () => {
  const opts = parseSetupArgs(["--wrangler", "--name", "laptop", "--yes"]);
  assert.equal(opts.requested, "wrangler");
  assert.equal(opts.tokenName, "laptop");
  assert.equal(opts.assumeYes, true);
});

test("--vault and --name are different things and do not collide", () => {
  // `--name` was already taken by the access token's label when second vaults were added, so
  // the deployment gets `--vault`. Parsing them together is the case that would silently
  // deploy the wrong vault, or label a token with a vault name, if they were ever merged.
  const opts = parseSetupArgs(["--token", "--vault", "notes-2", "--name", "phone"]);
  assert.equal(opts.vault, "notes-2");
  assert.equal(opts.tokenName, "phone");
});

test("contradictory or malformed setup args fail instead of guessing", () => {
  assert.throws(() => parseSetupArgs(["--wrangler", "--token"]), /mutually exclusive/);
  assert.throws(() => parseSetupArgs(["--name"]), /needs a value/);
  assert.throws(() => parseSetupArgs(["--name", "--yes"]), /needs a value/);
  assert.throws(() => parseSetupArgs(["--deploy"]), /unknown option/);
  assert.throws(() => parseSetupArgs(["--relogin"]), /unknown option/);
  assert.throws(() => parseSetupArgs(["--vault"]), /needs a name/);
  assert.throws(() => parseSetupArgs(["--vault", "--yes"]), /needs a name/);
});

test("the REST deploy check names the target without printing the whole account id", () => {
  const text = renderRestDeployCheck({
    accountId: "0123456789abcdef0123456789abcdef",
    scriptName: "obsidian-log-sync",
    bucket: "obsidian-log-sync",
    bucketOwned: false,
  });
  assert.match(text, /01234567…/);
  assert.doesNotMatch(text, /0123456789abcdef0123456789abcdef/);
  assert.match(text, /obsidian-log-sync/);
  assert.match(text, /stop rather than adopt it/);

  const redeploy = renderRestDeployCheck({
    accountId: "0123456789abcdef0123456789abcdef",
    scriptName: "obsidian-log-sync",
    bucket: "obsidian-log-sync",
    bucketOwned: true,
  });
  assert.match(redeploy, /created by this checkout/);
});

// --- named deployments (second vaults) ---------------------------------------

/** A repo root holding a default `.env` and, optionally, one named deployment's file. */
function envRoot(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "r2do-env-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

test("the default deployment keeps exactly the precedence it always had", () => {
  const root = envRoot({ ".env": "CLOUDFLARE_TOKEN=from-file\nWORKER_URL=https://stored.example\n" });

  const { file, scoped, env } = resolveDeploymentEnv({
    root,
    deploymentName: null,
    processEnv: { WORKER_URL: "https://from-environment.example" },
  });

  assert.equal(file, ".env");
  assert.equal(scoped, false);
  assert.equal(env.CLOUDFLARE_TOKEN, "from-file");
  // The real environment still wins for the default deployment. Changing that would break
  // every existing CI invocation that exports WORKER_URL.
  assert.equal(env.WORKER_URL, "https://from-environment.example");
});

test("a named vault never inherits the default deployment's identity", () => {
  // The one that matters. `.env` holds production's URL, admin token and bucket claim. If any
  // of them leaks into a named deploy: the fork guard compares this vault against
  // production's URL and refuses the deploy as a rename; the bucket claim vouches for storage
  // this vault never provisioned; and the admin token is checked against — and could be
  // written over — another vault's Worker.
  const root = envRoot({
    ".env": [
      "CLOUDFLARE_TOKEN=account-token",
      "CLOUDFLARE_ACCOUNT_ID=acct-1",
      "WORKER_URL=https://obsidian-log-sync.example.workers.dev",
      "ADMIN_TOKEN=production-admin",
      "VAULT_BUCKET_OWNED=acct-1:obsidian-log-sync",
    ].join("\n"),
  });

  const { file, scoped, env } = resolveDeploymentEnv({ root, deploymentName: "notes-2", processEnv: {} });

  assert.equal(file, ".env.notes-2");
  assert.equal(scoped, true);
  // Credentials are shared: a second vault normally lives on the same account, and copying a
  // Cloudflare token into every file would spread it around the disk for nothing.
  assert.equal(env.CLOUDFLARE_TOKEN, "account-token");
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, "acct-1");
  // Identity is not.
  assert.equal(env.WORKER_URL, undefined);
  assert.equal(env.ADMIN_TOKEN, undefined);
  assert.equal(env.VAULT_BUCKET_OWNED, undefined);
});

test("a named vault reads its identity from its own file, and not from the environment", () => {
  const root = envRoot({
    ".env": "CLOUDFLARE_TOKEN=account-token\nWORKER_URL=https://production.example\n",
    ".env.notes-2": "WORKER_URL=https://notes-2.example.workers.dev\nADMIN_TOKEN=second-admin\n",
  });

  const { env } = resolveDeploymentEnv({
    root,
    deploymentName: "notes-2",
    // An exported WORKER_URL is almost always production's, left over from an earlier
    // command. For a named vault the file is the only authority.
    processEnv: { WORKER_URL: "https://production.example", CLOUDFLARE_TOKEN: "env-token" },
  });

  assert.equal(env.WORKER_URL, "https://notes-2.example.workers.dev");
  assert.equal(env.ADMIN_TOKEN, "second-admin");
  // Credentials still honour the environment, which is how CI passes them.
  assert.equal(env.CLOUDFLARE_TOKEN, "env-token");
});

test("a named vault's first deploy has no identity rather than a borrowed one", () => {
  // `.env.notes-2` does not exist yet. An inherited WORKER_URL here is what would make the
  // fork guard refuse the very first deploy of a new vault.
  const root = envRoot({ ".env": "CLOUDFLARE_TOKEN=t\nWORKER_URL=https://production.example\n" });
  const { env } = resolveDeploymentEnv({ root, deploymentName: "notes-2", processEnv: {} });
  assert.equal(env.WORKER_URL, undefined);
  assert.equal(env.CLOUDFLARE_TOKEN, "t");
});

test("a deployment name that could name a path is refused where it becomes one", () => {
  // `deploymentEnvFile` is what `upsertEnvFile` writes an admin token through, so a name that
  // escapes the repo root has to die here even though callers validate too.
  assert.equal(deploymentEnvFile(null), ".env");
  assert.equal(deploymentEnvFile("notes-2"), ".env.notes-2");
  for (const bad of ["../secrets", "a/b", ".env", "UPPER", "-lead", "trail-", "x", ""]) {
    assert.throws(() => deploymentEnvFile(bad), /unusable deployment name/, `expected "${bad}" refused`);
  }
});

test("env files are written per deployment, and one never overwrites another", () => {
  const root = envRoot({ ".env": "CLOUDFLARE_TOKEN=keep-me\nWORKER_URL=https://production.example\n" });

  upsertEnvFile(root, { WORKER_URL: "https://notes-2.example", ADMIN_TOKEN: "a2" }, ".env.notes-2");

  assert.match(readFileSync(path.join(root, ".env.notes-2"), "utf8"), /WORKER_URL=https:\/\/notes-2\.example/);
  // The default deployment's file is untouched — losing production's URL and admin token to a
  // second vault's deploy is the failure this separation exists to prevent.
  const original = readFileSync(path.join(root, ".env"), "utf8");
  assert.match(original, /WORKER_URL=https:\/\/production\.example/);
  assert.match(original, /CLOUDFLARE_TOKEN=keep-me/);
  assert.equal(statSync(path.join(root, ".env.notes-2")).mode & 0o777, 0o600);
});

test("a vault name comes from the flag, then the environment, then not at all", () => {
  assert.deepEqual(resolveDeploymentRequest({ flag: "notes-2", processEnv: {} }), {
    requested: "notes-2",
    source: "--vault",
  });
  // An explicit flag beats a stale exported VAULT_NAME rather than conflicting with it.
  assert.deepEqual(resolveDeploymentRequest({ flag: "notes-2", processEnv: { VAULT_NAME: "other" } }), {
    requested: "notes-2",
    source: "--vault",
  });
  assert.deepEqual(resolveDeploymentRequest({ flag: null, processEnv: { VAULT_NAME: "notes-2" } }), {
    requested: "notes-2",
    source: "VAULT_NAME",
  });
  assert.deepEqual(resolveDeploymentRequest({ flag: null, processEnv: {} }), {
    requested: null,
    source: null,
  });
  // An empty value is not a vault name, so it must not select a `.env.` file.
  assert.deepEqual(resolveDeploymentRequest({ flag: "  ", processEnv: { VAULT_NAME: "  " } }), {
    requested: null,
    source: null,
  });
});

test("the deploy check says a named vault is a separate, empty one", () => {
  const text = renderRestDeployCheck({
    accountId: "0123456789abcdef0123456789abcdef",
    scriptName: "notes-2",
    bucket: "notes-2",
    bucketOwned: false,
    deploymentName: "notes-2",
    envFile: ".env.notes-2",
  });
  assert.match(text, /SEPARATE VAULT "notes-2"/);
  assert.match(text, /Records\s+\.env\.notes-2/);
  // The mistake this screen exists to stop: pointing an existing device at a new vault.
  assert.match(text, /NEW, EMPTY vault/);

  // A redeploy onto its own storage is not announced as a new vault.
  const redeploy = renderRestDeployCheck({
    accountId: "0123456789abcdef0123456789abcdef",
    scriptName: "notes-2",
    bucket: "notes-2",
    bucketOwned: true,
    deploymentName: "notes-2",
    envFile: ".env.notes-2",
  });
  assert.doesNotMatch(redeploy, /NEW, EMPTY vault/);
});

test("a recovery command never silently drops the vault it was fixing", () => {
  // Both messages recommend a follow-up command. Printed bare while --vault was in force,
  // they name the DEFAULT deployment — where they succeed, replace its same-named access
  // token, and leave the vault the user was actually repairing untouched.
  const source = readFileSync(path.join(ROOT, "scripts", "access-token.mjs"), "utf8");
  assert.match(source, /issue one with: node scripts\/access-token\.mjs\$\{vaultFlag\(\)\}/);
  assert.match(source, /re-run \\`node scripts\/setup\.mjs\$\{vaultFlag\(\)\}\\`/);
  // The 401 handler runs outside main(), so the resolved vault has to be reachable from it.
  assert.match(source, /^let selectedVault = null;$/m);
  assert.match(source, /selectedVault = requested;/);
});

test("every generated credentials file is ignored, and the example is not", () => {
  // Each .env.<name> holds an ADMIN_TOKEN that mints vault-wide access tokens. Ignoring only
  // the exact name `.env` left them untracked-but-addable, so `git add -A` would publish one.
  const ignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(ignore, /^\.env\.\*$/m);
  assert.match(ignore, /^!\.env\.example$/m);
});

test("setup args carry an explicit Worker adoption separately from the bucket", () => {
  // Two different resources: adopting a bucket must not silently adopt a script, because
  // adopting a script REPLACES its code, bindings and cron.
  assert.equal(parseSetupArgs(["--adopt-bucket"]).adoptWorker, false);
  assert.equal(parseSetupArgs(["--adopt-worker"]).adoptBucket, false);
  assert.equal(parseSetupArgs(["--adopt-worker"]).adoptWorker, true);
});

test("the closing summary carries the vault through to the commands it prints", () => {
  const text = renderSetupSummary({
    workerUrl: "https://notes-2.example.workers.dev",
    accessToken: "tok",
    deploymentName: "notes-2",
    envFile: ".env.notes-2",
  });
  // Printing the bare command would send the reader's next token operation to the DEFAULT
  // vault, which succeeds and mints against the wrong remote.
  assert.match(text, /access-token\.mjs --vault notes-2 --rotate/);
  assert.match(text, /\.\/\.env\.notes-2/);
  assert.doesNotMatch(text, /saved to \.\/\.env /);

  const def = renderSetupSummary({ workerUrl: "https://x.example", accessToken: "tok" });
  assert.match(def, /access-token\.mjs --rotate/);
  assert.match(def, /saved to \.\/\.env /);
});

test("the deploy check states the retention the sweep will delete by", () => {
  const text = renderRestDeployCheck({
    accountId: "0123456789abcdef0123456789abcdef",
    scriptName: "obsidian-log-sync",
    bucket: "obsidian-log-sync",
    bucketOwned: true,
    retention: { GC_KEEP_DAYS: "7", GC_KEEP_COUNT: "5", GC_DAILY_DAYS: "60" },
  });
  // All three tiers, because the one a reader is most likely to misjudge is the last: what
  // survives past the daily tier is kept for good, not deleted at the end of it.
  assert.match(text, /Retention\s+every snapshot for 7 day\(s\) \(at least the newest 5\),/);
  assert.match(text, /then one a day to 60 day\(s\), then one a week/);
});

// --- which account gets the worker -------------------------------------------

test("explicit --token requires both REST credentials", () => {
  assert.equal(
    resolveAuthPath({ requested: "token", hasToken: true, hasAccountId: true }).path,
    "token"
  );
  assert.throws(
    () => resolveAuthPath({ requested: "token", hasToken: true, hasAccountId: false }),
    /CLOUDFLARE_ACCOUNT_ID/
  );
  assert.throws(
    () => resolveAuthPath({ requested: "token", hasToken: false, hasAccountId: true }),
    /CLOUDFLARE_TOKEN/
  );
});

test("a configured REST token wins auto-detection", () => {
  const auth = resolveAuthPath({ requested: null, hasToken: true, hasAccountId: true, wranglerAccount: "someone@example.com" });
  assert.equal(auth.path, "token");
  assert.match(auth.reason, /CLOUDFLARE_TOKEN/);
});

test("a half-configured REST token never silently falls back to wrangler", () => {
  // The two paths can be two different Cloudflare accounts; quietly switching would
  // provision the vault somewhere the user did not intend.
  assert.throws(
    () =>
      resolveAuthPath({
        requested: null,
        hasToken: true,
        hasAccountId: false,
        wranglerAccount: "someone@example.com",
      }),
    /CLOUDFLARE_ACCOUNT_ID is not[\s\S]*--wrangler/
  );
});

test("auto-detection uses wrangler only when nothing else is configured", () => {
  const loggedIn = resolveAuthPath({ requested: null, hasToken: false, hasAccountId: false, wranglerAccount: "me@example.com" });
  assert.deepEqual(
    { path: loggedIn.path, needsLogin: loggedIn.needsLogin },
    { path: "wrangler", needsLogin: false }
  );

  const fresh = resolveAuthPath({ requested: null, hasToken: false, hasAccountId: false, wranglerAccount: null });
  assert.deepEqual({ path: fresh.path, needsLogin: fresh.needsLogin }, { path: "wrangler", needsLogin: true });
});

test("--wrangler alongside a REST token is flagged as a conflict to confirm", () => {
  const auth = resolveAuthPath({ requested: "wrangler", hasToken: true, hasAccountId: true, wranglerAccount: "other@example.com" });
  assert.equal(auth.path, "wrangler");
  assert.equal(auth.conflict, true);
});

const WHOAMI = `
 ⛅️ wrangler 4.42.0
-------------------
Getting User settings...
👋 You are logged in with an OAuth Token, associated with the email user@example.com.
┌────────────────────┬──────────────────────────────────┐
│ Account Name       │ Account ID                       │
├────────────────────┼──────────────────────────────────┤
│ User's Account     │ 0123456789abcdef0123456789abcdef │
└────────────────────┴──────────────────────────────────┘
`;

test("the wrangler account is named so a wrong login is visible", () => {
  const account = parseWranglerAccount(WHOAMI);
  assert.match(account, /user@example\.com/);
  assert.match(account, /User's Account \(0123456789abcdef0123456789abcdef\)/);
  assert.equal(parseWranglerAccount("You are not authenticated."), null);
  assert.equal(parseWranglerAccount(""), null);
});

test("the account check offers the way out of a wrong login", () => {
  const text = renderAccountCheck({
    account: "user@example.com",
    scriptName: "obsidian-log-sync",
    bucket: "obsidian-log-sync",
    conflict: true,
  });
  assert.match(text, /user@example\.com/);
  // The way out is a command the user runs; setup never changes the login itself.
  assert.match(text, /wrangler\.js logout && node worker\/node_modules\/wrangler\/bin\/wrangler\.js login/);
  assert.doesNotMatch(text, /--relogin/);
  assert.match(text, /CLOUDFLARE_TOKEN is configured/);
});

// --- rotation ----------------------------------------------------------------

function fakeAdminApi({ devices = [] } = {}) {
  const calls = [];
  const state = devices.map((d) => ({ ...d }));
  let minted = 0;
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.replace("https://sync.example.com", "")}`);
    if (method === "GET") {
      return { status: 200, json: async () => ({ tokens: state.filter((d) => !d.revoked) }) };
    }
    if (method === "POST") {
      minted++;
      const device = { id: `new-${minted}`, name: JSON.parse(init.body).name };
      state.push(device);
      return { status: 201, json: async () => ({ ...device, token: `token-${minted}` }) };
    }
    const id = decodeURIComponent(url.split("/").pop());
    const found = state.find((d) => d.id === id);
    if (!found) return { status: 404, text: async () => "unknown" };
    found.revoked = true;
    return { status: 204 };
  };
  return { fetchImpl, calls, state };
}

test("rotation mints a replacement and revokes every other active token", async () => {
  const api = fakeAdminApi({
    devices: [
      { id: "old-1", name: "vault" },
      { id: "old-2", name: "phone" },
    ],
  });

  const { minted, revoked } = await rotateAccessToken({
    workerUrl: "https://sync.example.com",
    adminToken: "admin",
    fetchImpl: api.fetchImpl,
  });

  assert.equal(minted.token, "token-1");
  assert.deepEqual(revoked.map((d) => d.id), ["old-1", "old-2"]);
  // The new token must survive its own rotation.
  assert.deepEqual(
    api.state.filter((d) => !d.revoked).map((d) => d.id),
    ["new-1"]
  );
  assert.deepEqual(api.calls, [
    "GET /api/tokens",
    "POST /api/tokens",
    "DELETE /api/tokens/old-1",
    "DELETE /api/tokens/old-2",
  ]);
});

test("re-issuing a name replaces that token instead of stacking a second live one", async () => {
  // Running the issue command twice must not leave two tokens called "vault": nothing
  // tells them apart afterwards, so a later revoke becomes a coin flip.
  const api = fakeAdminApi({ devices: [{ id: "old-1", name: "vault" }] });

  const { minted, revoked } = await mintOrReplaceAccessToken({
    workerUrl: "https://sync.example.com",
    adminToken: "admin",
    name: "vault",
    fetchImpl: api.fetchImpl,
  });

  assert.deepEqual(revoked.map((d) => d.id), ["old-1"]);
  assert.deepEqual(
    api.state.filter((d) => !d.revoked).map((d) => d.id),
    [minted.id]
  );
  // Replacement is issued BEFORE the old one dies, so a failure mid-way still leaves a
  // working token rather than none.
  assert.deepEqual(api.calls, ["GET /api/tokens", "POST /api/tokens", "DELETE /api/tokens/old-1"]);
});

test("re-issuing leaves tokens with other names alone", async () => {
  const api = fakeAdminApi({
    devices: [
      { id: "old-1", name: "vault" },
      { id: "phone-1", name: "phone" },
    ],
  });

  await mintOrReplaceAccessToken({
    workerUrl: "https://sync.example.com",
    adminToken: "admin",
    name: "vault",
    fetchImpl: api.fetchImpl,
  });

  assert.deepEqual(
    api.state.filter((d) => !d.revoked).map((d) => d.name).sort(),
    ["phone", "vault"]
  );
});

test("issuing converges to one token even after earlier duplicates piled up", async () => {
  const api = fakeAdminApi({
    devices: [
      { id: "dup-1", name: "vault" },
      { id: "dup-2", name: "vault" },
    ],
  });

  const { minted } = await mintOrReplaceAccessToken({
    workerUrl: "https://sync.example.com",
    adminToken: "admin",
    name: "vault",
    fetchImpl: api.fetchImpl,
  });

  assert.deepEqual(
    api.state.filter((d) => !d.revoked).map((d) => d.id),
    [minted.id]
  );
});

test("issuing the first token revokes nothing", async () => {
  const api = fakeAdminApi();
  const { revoked } = await mintOrReplaceAccessToken({
    workerUrl: "https://sync.example.com",
    adminToken: "admin",
    name: "vault",
    fetchImpl: api.fetchImpl,
  });
  assert.deepEqual(revoked, []);
  assert.deepEqual(api.calls, ["GET /api/tokens", "POST /api/tokens"]);
});

test("rotation reports a failed revoke instead of claiming the old token is dead", async () => {
  const api = fakeAdminApi({ devices: [{ id: "ghost", name: "gone" }] });
  const fetchImpl = async (url, init = {}) =>
    (init.method ?? "GET") === "DELETE"
      ? { status: 500, text: async () => "boom" }
      : api.fetchImpl(url, init);

  await assert.rejects(
    rotateAccessToken({ workerUrl: "https://sync.example.com", adminToken: "admin", fetchImpl }),
    /revoke ghost failed: HTTP 500/
  );
});

// --- health polling ----------------------------------------------------------

test("health polling waits out propagation, then gives up loudly", async () => {
  let attempt = 0;
  const flaky = async () => {
    attempt++;
    if (attempt < 3) throw new Error("ENOTFOUND");
    return { status: 200, json: async () => ({ ok: true }) };
  };
  assert.equal(
    await waitForHealth({ workerUrl: "https://x.test", fetchImpl: flaky, sleep: async () => {} }),
    true
  );

  assert.equal(
    await waitForHealth({
      workerUrl: "https://x.test",
      fetchImpl: async () => ({ status: 500, json: async () => ({}) }),
      attempts: 2,
      sleep: async () => {},
    }),
    false
  );
});

// --- the stored admin credential ---------------------------------------------

test("the admin credential check maps statuses to keep / rotate / stop", async () => {
  const ok = async () => ({ status: 200, json: async () => ({ tokens: [] }) });
  assert.equal(
    await verifyAdminToken({ workerUrl: "https://x.test", adminToken: "a", fetchImpl: ok }),
    true
  );

  // 401/403 is a definitive "not this credential" — the caller rotates the secret.
  for (const status of [401, 403]) {
    const denied = async () => ({ status, text: async () => "nope" });
    assert.equal(
      await verifyAdminToken({ workerUrl: "https://x.test", adminToken: "a", fetchImpl: denied }),
      false
    );
  }

  // Anything else is not an auth answer; rotating would not fix it, so it must stop.
  const broken = async () => ({ status: 500, text: async () => "boom" });
  await assert.rejects(
    verifyAdminToken({ workerUrl: "https://x.test", adminToken: "a", fetchImpl: broken }),
    /admin token check failed: HTTP 500 boom/
  );
});

// --- .env, written by whichever OS the user has ------------------------------

test("a .env parses the same whether it was written with LF or CRLF endings", () => {
  // Reported as issue #9 from Windows. `split("\n")` leaves `\r` on the end of every line,
  // and the value regex is `$`-anchored with a `(.*)` that cannot match `\r` — so a CRLF
  // file did not parse to slightly-wrong values, it parsed to NOTHING, and setup then
  // reported the credentials as simply absent.
  const body = "# deploy credentials\nCLOUDFLARE_TOKEN=cf-secret\nWORKER_URL=https://x.example.com\n";
  const expected = { CLOUDFLARE_TOKEN: "cf-secret", WORKER_URL: "https://x.example.com" };

  for (const [label, text] of [
    ["LF", body],
    ["CRLF", body.replace(/\n/g, "\r\n")],
  ]) {
    const root = mkdtempSync(path.join(tmpdir(), "setup-lib-eol-"));
    writeFileSync(path.join(root, ".env"), text);
    assert.deepEqual(loadEnvFile(root), expected, `${label} .env`);
  }
});

test("upserting a CRLF .env keeps the user's lines intact and does not double up keys", () => {
  const root = mkdtempSync(path.join(tmpdir(), "setup-lib-eol-"));
  const file = path.join(root, ".env");
  writeFileSync(file, "# mine\r\nCLOUDFLARE_TOKEN=cf-secret\r\nWORKER_URL=https://old.example.com\r\n");

  upsertEnvFile(root, { WORKER_URL: "https://new.example.com" });

  // Re-reading is the assertion that matters: a `\r` left mid-file would strand the key.
  assert.deepEqual(loadEnvFile(root), {
    CLOUDFLARE_TOKEN: "cf-secret",
    WORKER_URL: "https://new.example.com",
  });
  const text = readFileSync(file, "utf8");
  assert.match(text, /^# mine$/m);
  assert.equal(text.match(/^WORKER_URL=/gm).length, 1);
});

// --- locally installed CLIs --------------------------------------------------

test("localBin names a package's own entrypoint, never the .bin shim", () => {
  // The `.bin` shim is `wrangler.cmd` on Windows: unspawnable without `shell: true`, which
  // would hand every argument — bucket names, account ids — to cmd.exe to re-parse.
  const entry = localBin(path.join(ROOT, "worker"), "wrangler/bin/wrangler.js");
  assert.equal(entry, path.join(ROOT, "worker", "node_modules", "wrangler", "bin", "wrangler.js"));
  assert.doesNotMatch(entry, /[/\\]\.bin[/\\]/);
});

test("upserting .env replaces managed keys and leaves everything else untouched", () => {
  const root = mkdtempSync(path.join(tmpdir(), "setup-lib-env-"));
  writeFileSync(
    path.join(root, ".env"),
    "# deploy credentials\nCLOUDFLARE_TOKEN=cf-secret\nWORKER_URL=https://old.example.com\n"
  );

  upsertEnvFile(root, { WORKER_URL: "https://new.example.com", ADMIN_TOKEN: "admin-value" });

  const text = readFileSync(path.join(root, ".env"), "utf8");
  // The user's own lines survive verbatim; ours are replaced in place, not duplicated.
  assert.match(text, /^# deploy credentials$/m);
  assert.match(text, /^CLOUDFLARE_TOKEN=cf-secret$/m);
  assert.match(text, /^WORKER_URL=https:\/\/new\.example\.com$/m);
  assert.match(text, /^ADMIN_TOKEN=admin-value$/m);
  assert.doesNotMatch(text, /old\.example\.com/);
  assert.equal(text.match(/^WORKER_URL=/gm).length, 1);
});

test("upserting .env creates the file when there is none", () => {
  const root = mkdtempSync(path.join(tmpdir(), "setup-lib-env-"));
  upsertEnvFile(root, { WORKER_URL: "https://fresh.example.com", ADMIN_TOKEN: "admin-value" });
  assert.equal(
    readFileSync(path.join(root, ".env"), "utf8"),
    "WORKER_URL=https://fresh.example.com\nADMIN_TOKEN=admin-value\n"
  );
  assert.equal(statSync(path.join(root, ".env")).mode & 0o777, 0o600);
});

test("upserting .env tightens the permissions of a file that already existed", () => {
  // `mode:` on writeFileSync only applies at CREATION. An .env left world-readable by an
  // editor, or copied from .env.example, keeps 0644 — and this function is what writes the
  // admin token and a vault-wide access token into it.
  const root = mkdtempSync(path.join(tmpdir(), "setup-lib-env-"));
  const file = path.join(root, ".env");
  writeFileSync(file, "CLOUDFLARE_TOKEN=cf-secret\n", { mode: 0o644 });
  chmodSync(file, 0o644);
  assert.equal(statSync(file).mode & 0o777, 0o644);

  upsertEnvFile(root, { ADMIN_TOKEN: "admin-value" });

  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(readFileSync(file, "utf8"), /^CLOUDFLARE_TOKEN=cf-secret$/m);
});

// --- the output the whole script exists to print -----------------------------

test("the summary carries everything that must reach the plugin, and no admin secret", () => {
  const text = renderSetupSummary({
    workerUrl: "https://sync.example.com",
    accessToken: "access-token-value",
    tokenName: "vault",
  });
  assert.match(text, /https:\/\/sync\.example\.com/);
  assert.match(text, /access-token-value/);
  assert.match(text, /install-plugin\.mjs/);
  // The wording must match the actual plugin controls, not an idealised UI.
  assert.match(text, /a window asks you to save it/);
  assert.match(text, /cd plugin && node build\.mjs && cd \.\./);
  assert.match(text, /enable "R2DO Sync"/);
  assert.match(text, /--rotate/);
  // The master-key warning is the one thing no support call can undo.
  assert.match(text, /master key never leaves your devices/);
  // The admin credential is managed in ./.env, never handed to the user — the summary
  // says it exists and where it lives ("nothing to do here"), but must never print a
  // value or tell anyone to store one by hand.
  assert.match(text, /GOOD TO KNOW \(nothing to do here\)/);
  assert.match(text, /ADMIN_TOKEN\) was saved to \.\/\.env/);
  assert.match(text, /re-running setup fixes it/);
  assert.doesNotMatch(text, /ADMIN_TOKEN=/);
  // Scoped to the admin section rather than the whole summary. The steps above it now tell
  // the user to put the *master key* in a password manager, which is correct and is the one
  // secret they must handle by hand; a blanket ban on the phrase forbade that too.
  const adminSection = text.slice(text.indexOf("GOOD TO KNOW"));
  assert.doesNotMatch(adminSection, /password manager|store it/i);
  assert.match(text, /Copy it into a password manager/);
});

test("a summary without an access token is a bug, not a message to explain", () => {
  // Setup now always ends holding a working admin credential, so "could not issue"
  // has no legitimate rendering — reaching this line without a token must throw.
  assert.throws(
    () => renderSetupSummary({ workerUrl: "https://sync.example.com", accessToken: null }),
    /setup always issues one/
  );
});
