#!/usr/bin/env node
// Manages the vault's access token. Run it yourself so tokens never pass through an agent
// transcript or your shell history.
//
//   node scripts/access-token.mjs                 issue the access token, replacing the
//                                                 existing one of the same name
//   node scripts/access-token.mjs --list          list active tokens (no token material)
//   node scripts/access-token.mjs --rotate        issue a fresh one and revoke ALL others
//   node scripts/access-token.mjs --revoke <id>   revoke one token
//   node scripts/access-token.mjs --name phone    a separately revocable extra token
//   node scripts/access-token.mjs --out tok.json  write the token to a 0600 file instead
//   node scripts/access-token.mjs --print-token   print it even without a terminal
//   node scripts/access-token.mjs --vault notes-2 operate on a separate vault (.env.notes-2)
//
// There is nothing to manage per device: one access token authenticates the vault, and
// every device can share it (that is what the setup QR does). Names are just labels.
// First-time setup does not need this at all — scripts/setup.mjs issues the token.
// The admin credential comes from that deployment's env file (setup.mjs stores it there
// automatically), else a hidden prompt.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  ROOT,
  listAccessTokens,
  mintOrReplaceAccessToken,
  normalizeWorkerUrl,
  renderSetupSummary,
  resolveDeploymentEnv,
  resolveDeploymentRequest,
  revokeAccessToken,
  rotateAccessToken,
  tokenOutputPlan,
  writeTokenHandoff,
} from "./setup-lib.mjs";

export { normalizeWorkerUrl };

const USAGE = `usage: node scripts/access-token.mjs [--vault <name>] [--name <label>] [--out <file>] [--print-token]
       node scripts/access-token.mjs [--vault <name>] --list
       node scripts/access-token.mjs [--vault <name>] --rotate [--name <label>] [--out <file>]
       node scripts/access-token.mjs [--vault <name>] --revoke <token-id>

--vault selects a separate vault stood up with \`setup.mjs --vault <name>\` (also settable
as VAULT_NAME); its URL and admin credential live in .env.<name>. Without it, the default
deployment in .env is used, exactly as before.`;

/**
 * WORKER_URL for the selected deployment. No default: guessing the wrong host would send an
 * admin token somewhere it does not belong — and with several vaults on one account, falling
 * back to another deployment's URL would mint a token against the wrong vault, which looks
 * like success until a device syncs the wrong notes.
 */
export function workerUrl(env, file = ".env") {
  const value = env.WORKER_URL;
  if (!value) {
    throw new Error(
      `WORKER_URL is not set for this deployment — run \`node scripts/setup.mjs\` once (it\n` +
        `stores WORKER_URL and ADMIN_TOKEN in ./${file} for you), or add it to ${file}\n` +
        "yourself. There is deliberately no default: guessing a host would send your admin\n" +
        "token there."
    );
  }
  return value.trim();
}

async function promptHidden(question, env) {
  // The deployment's env file is gitignored and already holds the deploy credentials, so an
  // ADMIN_TOKEN kept there makes this a single non-interactive command. Leave it out to be
  // prompted instead — that keeps the admin token off disk entirely.
  const stored = env.ADMIN_TOKEN;
  if (stored) return stored.trim();
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const original = rl._writeToOutput?.bind(rl);
  rl._writeToOutput = function (s) {
    if (s.includes(question)) original?.(s);
  };
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  process.stdout.write("\n");
  if (original) rl._writeToOutput = original;
  return answer.trim();
}

/**
 * The vault this run resolved to, for the messages that recommend a follow-up command.
 *
 * Module scope because the failure handler below runs outside `main()`. A recovery command
 * printed without `--vault` operates on the DEFAULT deployment and succeeds there — replacing
 * its same-named access token, and leaving the vault the user was actually fixing untouched.
 */
let selectedVault = null;
const vaultFlag = () => (selectedVault === null ? "" : ` --vault ${selectedVault}`);

/** The same closing notice setup.mjs prints, so a device needs exactly one command. */
function summary(workerUrl, accessToken, name, deployment) {
  return renderSetupSummary({
    workerUrl,
    accessToken,
    tokenName: name,
    deploymentName: deployment.deploymentName,
    envFile: deployment.file,
  });
}

/** Pure argument parsing, so the CLI's shape is testable without a server. */
export function parseAccessTokenArgs(argv) {
  const opts = { mode: "issue", name: "vault", id: null, out: null, printToken: false, vault: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--vault") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--vault needs a name");
      opts.vault = value;
    } else if (arg === "--list") opts.mode = "list";
    else if (arg === "--rotate") opts.mode = "rotate";
    else if (arg === "--revoke") {
      opts.mode = "revoke";
      opts.id = argv[++i] ?? null;
    } else if (arg === "--name") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--name needs a value");
      opts.name = value;
    } else if (arg === "--out") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--out needs a file path");
      opts.out = value;
    } else if (arg === "--print-token") {
      opts.printToken = true;
    } else {
      throw new Error(`unknown option "${arg}"`);
    }
  }
  if (opts.mode === "revoke" && !opts.id) throw new Error("--revoke needs a token id");
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseAccessTokenArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }

  // Which vault, before which URL: with several deployments on one account, reading the
  // wrong file mints a real token against the wrong vault.
  const { requested } = resolveDeploymentRequest({ flag: opts.vault });
  selectedVault = requested;
  let deployment;
  try {
    deployment = resolveDeploymentEnv({ root: ROOT, deploymentName: requested });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  if (requested !== null) console.log(`vault "${requested}" (${deployment.file})`);
  const WORKER_URL = normalizeWorkerUrl(workerUrl(deployment.env, deployment.file));

  // Decided before anything is minted: a token is returned exactly once, so refusing to
  // hand it over afterwards would destroy a credential rather than protect it.
  const output =
    opts.mode === "list" || opts.mode === "revoke"
      ? { kind: "stdout" }
      : tokenOutputPlan({ isTty: Boolean(process.stdout.isTTY), out: opts.out, printToken: opts.printToken });
  if (output.kind === "refuse") {
    console.error(output.reason);
    process.exit(2);
  }

  const adminToken = await promptHidden("Admin token (input hidden): ", deployment.env);
  if (!adminToken) {
    console.error("no admin token supplied");
    process.exit(2);
  }
  const api = { workerUrl: WORKER_URL, adminToken };

  if (opts.mode === "list") {
    const tokens = await listAccessTokens(api);
    if (tokens.length === 0) {
      console.log(`no active access token — issue one with: node scripts/access-token.mjs${vaultFlag()}`);
      return;
    }
    console.log(`${tokens.length} active token(s):`);
    for (const t of tokens) console.log(`  ${t.id}  ${t.name}  (created ${t.createdAt})`);
    console.log("\nToken values are stored hashed and cannot be listed. Lost one? --rotate");
    return;
  }

  if (opts.mode === "revoke") {
    await revokeAccessToken({ ...api, id: opts.id });
    console.log(`revoked token ${opts.id}`);
    return;
  }

  const { minted, revoked } =
    opts.mode === "rotate"
      ? await rotateAccessToken({ ...api, name: opts.name })
      : await mintOrReplaceAccessToken({ ...api, name: opts.name });

  console.log(`id: ${minted.id}   (needed to revoke this one later)`);
  if (revoked.length > 0) {
    console.log(`replaced ${revoked.length} active token(s): ${revoked.map((t) => t.name).join(", ")}`);
    console.log("Any device still holding an old token now fails to sync until it gets this one.");
  }
  if (output.kind === "file") {
    const file = writeTokenHandoff(output.file, {
      workerUrl: WORKER_URL,
      accessToken: minted.token,
      tokenId: minted.id,
      tokenName: opts.name,
    });
    console.log(`access token written to ${file} (mode 0600). It is not printed here.`);
    return;
  }
  console.log(summary(WORKER_URL, minted.token, opts.name, deployment));
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`access token operation failed: ${message}`);
    if (/HTTP 401/.test(message)) {
      // The stored credential no longer matches the deployed secret; setup rotates it.
      console.error(
        `The stored ADMIN_TOKEN was not accepted — re-run \`node scripts/setup.mjs${vaultFlag()}\` to fix it.`
      );
    }
    process.exit(1);
  });
}
