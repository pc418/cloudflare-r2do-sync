import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { ROOT, parseWranglerAccount } from "./setup-lib.mjs";
import { SetupError, deployViaWrangler } from "./setup-wrangler.mjs";

const CONFIG = { scriptName: "obsidian-log-sync", bucket: "obsidian-log-sync" };
const DEPLOY_OUT = `
Total Upload: 197.20 KiB / gzip: 45.10 KiB
Uploaded obsidian-log-sync (3.21 sec)
Deployed obsidian-log-sync triggers (0.31 sec)
  https://obsidian-log-sync.example-user.workers.dev
Current Version ID: 0e1a...
`;

/**
 * A stand-in wrangler. `replies` maps the first two argv words to `{status, out}`;
 * anything unlisted succeeds silently, so a test only states what it cares about.
 */
function fakeWrangler(replies = {}) {
  const calls = [];
  const run = (args, opts = {}) => {
    calls.push({ args, opts });
    const reply = replies[args.slice(0, 2).join(" ")] ?? replies[args[0]];
    return reply ?? { status: 0, out: "" };
  };
  return { run, calls, commands: () => calls.map((c) => c.args.join(" ")) };
}

const base = (over = {}) => ({
  config: CONFIG,
  account: "user@example.com",
  assumeYes: true,
  randomHex: () => "f".repeat(64),
  log: () => {},
  // Only the stored-credential check may touch the network; tests that expect it
  // provide their own fetchImpl, every other path must never fetch.
  fetchImpl: async () => {
    throw new Error("unexpected network call");
  },
  ...over,
});

test("the wrangler path deploys, keeps order, and returns the URL it was told", async () => {
  const w = fakeWrangler({ deploy: { status: 0, out: DEPLOY_OUT } });

  const result = await deployViaWrangler({ ...base(), run: w.run });

  assert.deepEqual(result, {
    url: "https://obsidian-log-sync.example-user.workers.dev",
    adminToken: "f".repeat(64),
    adminTokenKept: false,
  });
  assert.deepEqual(w.commands(), [
    "r2 bucket create obsidian-log-sync",
    "deploy",
    "secret list",
    "secret put ADMIN_TOKEN",
  ]);
  // The generated secret is piped in, never passed as an argument where a process list
  // or shell history would capture it.
  const put = w.calls.at(-1);
  assert.equal(put.opts.input, `${"f".repeat(64)}\n`);
  assert.ok(!put.args.some((a) => a.includes("f".repeat(64))));
});

test("an already-existing bucket is not an error, a real bucket failure is", async () => {
  const existing = fakeWrangler({
    "r2 bucket": { status: 1, out: "A bucket with this name already exists [code: 10004]" },
    deploy: { status: 0, out: DEPLOY_OUT },
  });
  await assert.doesNotReject(deployViaWrangler({ ...base(), run: existing.run }));

  const denied = fakeWrangler({
    "r2 bucket": { status: 1, out: "Authentication error [code: 10000]" },
    deploy: { status: 0, out: DEPLOY_OUT },
  });
  await assert.rejects(deployViaWrangler({ ...base(), run: denied.run }), /could not create R2 bucket/);
  // It must stop before deploying rather than half-provisioning.
  assert.deepEqual(denied.commands(), ["r2 bucket create obsidian-log-sync"]);
});

const SECRET_LIST = {
  status: 0,
  out: '[\n  {\n    "name": "ADMIN_TOKEN",\n    "type": "secret_text"\n  }\n]',
};

test("a stored admin credential that still matches keeps the existing secret", async () => {
  const w = fakeWrangler({ deploy: { status: 0, out: DEPLOY_OUT }, "secret list": SECRET_LIST });
  const fetched = [];
  const fetchImpl = async (url, init) => {
    fetched.push({ url, auth: init.headers.authorization });
    return { status: 200, json: async () => ({ tokens: [] }) };
  };

  const result = await deployViaWrangler({
    ...base({ storedAdminToken: "stored-admin", fetchImpl }),
    run: w.run,
  });

  assert.equal(result.adminTokenKept, true);
  assert.equal(result.adminToken, "stored-admin");
  assert.ok(!w.commands().includes("secret put ADMIN_TOKEN"));
  // The check must hit the URL this deploy answered with, carrying the stored credential.
  assert.deepEqual(fetched, [
    {
      url: "https://obsidian-log-sync.example-user.workers.dev/api/tokens",
      auth: "Bearer stored-admin",
    },
  ]);
});

test("an existing secret with no stored credential is rotated, not a dead end", async () => {
  // The old behaviour kept the unreadable secret and ended without an access token.
  // The admin credential is script-plumbing, so the run rotates it and moves on.
  const w = fakeWrangler({ deploy: { status: 0, out: DEPLOY_OUT }, "secret list": SECRET_LIST });

  const result = await deployViaWrangler({ ...base(), run: w.run });

  assert.equal(result.adminTokenKept, false);
  assert.equal(result.adminToken, "f".repeat(64));
  assert.ok(w.commands().includes("secret put ADMIN_TOKEN"));
});

test("a stale stored credential is rotated instead of trusted", async () => {
  const w = fakeWrangler({ deploy: { status: 0, out: DEPLOY_OUT }, "secret list": SECRET_LIST });
  const fetchImpl = async () => ({ status: 401, text: async () => "invalid token" });

  const result = await deployViaWrangler({
    ...base({ storedAdminToken: "stale-admin", fetchImpl }),
    run: w.run,
  });

  assert.equal(result.adminTokenKept, false);
  assert.equal(result.adminToken, "f".repeat(64));
  assert.ok(w.commands().includes("secret put ADMIN_TOKEN"));
});

test("an unexpected answer to the credential check stops the run — rotation would not fix it", async () => {
  const w = fakeWrangler({ deploy: { status: 0, out: DEPLOY_OUT }, "secret list": SECRET_LIST });
  const fetchImpl = async () => ({ status: 503, text: async () => "worker unavailable" });

  await assert.rejects(
    deployViaWrangler({ ...base({ storedAdminToken: "stored-admin", fetchImpl }), run: w.run }),
    /admin token check failed: HTTP 503/
  );
  assert.ok(!w.commands().includes("secret put ADMIN_TOKEN"));
});

test("no workers.dev URL in the output stops instead of guessing a host", async () => {
  const w = fakeWrangler({ deploy: { status: 0, out: "Uploaded obsidian-log-sync (2.10 sec)" } });
  await assert.rejects(deployViaWrangler({ ...base(), run: w.run }), /will not guess the host/);
});

test("declining the account check deploys nothing", async () => {
  const w = fakeWrangler({ deploy: { status: 0, out: DEPLOY_OUT } });
  await assert.rejects(
    deployViaWrangler({ ...base({ assumeYes: false, confirm: async () => false }), run: w.run }),
    (error) => error instanceof SetupError && /wrangler logout/.test(error.message)
  );
  assert.deepEqual(w.commands(), []);
});

test("a logged-out CLI stops with instructions instead of logging you in", async () => {
  // Whose credentials provision the infrastructure is the user's decision, and a login
  // triggered from here would also replace whatever session they already had.
  const w = fakeWrangler({ deploy: { status: 0, out: DEPLOY_OUT } });

  await assert.rejects(
    deployViaWrangler({ ...base({ account: null }), run: w.run }),
    (error) => error instanceof SetupError && /node_modules\/\.bin\/wrangler login/.test(error.message)
  );
  assert.deepEqual(w.commands(), []);
});

test("no path ever runs wrangler login or logout", async () => {
  const w = fakeWrangler({ deploy: { status: 0, out: DEPLOY_OUT } });
  await deployViaWrangler({ ...base(), run: w.run });
  const touched = w.commands().filter((c) => c === "login" || c === "logout");
  assert.deepEqual(touched, []);
});

// --- one real invocation, to prove the spawn wiring matches the fake ---------

test("the real wrangler binary answers whoami through the same call shape", (t) => {
  const bin = path.join(ROOT, "worker", "node_modules", ".bin", "wrangler");
  if (!existsSync(bin)) return t.skip("wrangler devDependency not installed");

  const res = spawnSync(bin, ["whoami"], {
    cwd: path.join(ROOT, "worker"),
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;

  assert.equal(res.error, undefined);
  assert.match(out, /wrangler/i);
  // Whatever the login state, the parser must return either a description or null —
  // never a half-parsed string that would be shown as the target account.
  const account = parseWranglerAccount(out);
  assert.ok(account === null || (typeof account === "string" && account.length > 0));
});
