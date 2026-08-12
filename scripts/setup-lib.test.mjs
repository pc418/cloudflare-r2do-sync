import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ROOT,
  parseSetupArgs,
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
  });
});

test("setup args carry the explicit choices", () => {
  const opts = parseSetupArgs(["--wrangler", "--name", "laptop", "--yes"]);
  assert.equal(opts.requested, "wrangler");
  assert.equal(opts.tokenName, "laptop");
  assert.equal(opts.assumeYes, true);
});

test("contradictory or malformed setup args fail instead of guessing", () => {
  assert.throws(() => parseSetupArgs(["--wrangler", "--token"]), /mutually exclusive/);
  assert.throws(() => parseSetupArgs(["--name"]), /needs a value/);
  assert.throws(() => parseSetupArgs(["--name", "--yes"]), /needs a value/);
  assert.throws(() => parseSetupArgs(["--deploy"]), /unknown option/);
  assert.throws(() => parseSetupArgs(["--relogin"]), /unknown option/);
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
  assert.match(text, /wrangler logout && \.\/worker\/node_modules\/\.bin\/wrangler login/);
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
