// The wrangler branch of scripts/setup.mjs, kept separate so it can be tested.
//
// Every effect goes through the injected `run` (one wrangler invocation), `log`, `confirm`
// and `randomHex`, so the branch that decides *what* wrangler is asked to do — and, more
// importantly, what it is NOT asked to do — is exercised without a Cloudflare account.
import { renderAccountCheck, verifyAdminToken } from "./setup-lib.mjs";

/** Thrown for a condition the user has to resolve; setup.mjs turns it into a clean exit. */
export class SetupError extends Error {}

/**
 * Deploys with the wrangler CLI and returns `{url, adminToken, adminTokenKept}` —
 * `adminToken` is always a working credential: the stored one when it still matches the
 * deployed secret, otherwise a fresh one that replaced it.
 *
 * `run(args, opts)` must return `{status, out}` for one wrangler invocation.
 */
export async function deployViaWrangler({
  config,
  account = null,
  assumeYes = false,
  conflict = false,
  storedAdminToken = null,
  run,
  log = console.log,
  confirm = async () => false,
  randomHex,
  fetchImpl = fetch,
}) {
  // Setup never logs wrangler in or out. Which credentials provision your infrastructure is
  // the one decision that must stay in the user's hands — and a login this script triggered
  // would also silently replace whatever session was already there.
  if (!account) {
    throw new SetupError(
      "wrangler is not logged in. Run `npx wrangler login` yourself (or\n" +
        "`npx wrangler logout && npx wrangler login` to switch accounts), then re-run setup."
    );
  }

  // Naming the account before the first write is the whole safety story of this path:
  // `wrangler login` persists, so the CLI is often still pointed at an earlier account.
  log(renderAccountCheck({ account, scriptName: config.scriptName, bucket: config.bucket, conflict }));
  if (!assumeYes && !(await confirm("Deploy to this account?"))) {
    throw new SetupError(
      "cancelled — switch accounts with `npx wrangler logout && npx wrangler login`, then re-run"
    );
  }

  // R2 bucket: create-if-missing. wrangler has no "ensure", so an existing bucket comes
  // back as an error that must be told apart from a real failure.
  log(`ensuring R2 bucket "${config.bucket}"...`);
  const bucket = run(["r2", "bucket", "create", config.bucket], { check: false, quiet: true });
  if (bucket.status !== 0 && !/already exists|10004/i.test(bucket.out)) {
    throw new SetupError(`could not create R2 bucket "${config.bucket}":\n${bucket.out.trim()}`);
  }
  log(bucket.status === 0 ? "  created" : "  already exists");

  log("deploying worker...");
  const deployed = run(["deploy"]);
  const url = deployed.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] ?? null;
  if (!url) {
    throw new SetupError(
      "wrangler did not print a workers.dev URL. Enable the workers.dev route for this\n" +
        "worker in the Cloudflare dashboard, then re-run — setup will not guess the host,\n" +
        "because a wrong one would send your tokens somewhere else."
    );
  }

  // A secret can never be read back, so on a redeploy the stored copy is the only way to
  // keep the existing ADMIN_TOKEN. When it is absent or stale, the secret is rotated:
  // that credential is script-plumbing, and access tokens live in the Durable Object,
  // so a rotation never breaks a device — but a run that ends without a working admin
  // credential would end without the access token the user came for.
  const listed = run(["secret", "list"], { check: false, quiet: true });
  const secretExists = /"?name"?\s*:?\s*"?ADMIN_TOKEN/i.test(listed.out);
  let adminToken = null;
  let adminTokenKept = false;
  if (secretExists && storedAdminToken) {
    log("checking the stored admin credential against the deployed secret...");
    if (await verifyAdminToken({ workerUrl: url, adminToken: storedAdminToken, fetchImpl })) {
      adminToken = storedAdminToken;
      adminTokenKept = true;
      log("  still valid, keeping it");
    } else {
      log("  stale — rotating the secret (existing access tokens are unaffected)");
    }
  } else if (secretExists) {
    log("no stored admin credential for the existing secret — rotating it");
  }
  if (adminToken === null) {
    adminToken = randomHex();
    log("setting the ADMIN_TOKEN secret...");
    run(["secret", "put", "ADMIN_TOKEN"], { input: `${adminToken}\n`, quiet: true });
  }

  return { url, adminToken, adminTokenKept };
}
