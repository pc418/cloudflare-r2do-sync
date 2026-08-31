import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_OBSERVABILITY } from "./deploy.mjs";

test("REST deploy metadata enables sampled Workers logs", () => {
  assert.deepEqual(WORKER_OBSERVABILITY, { enabled: true, head_sampling_rate: 0.01 });
});

test("the REST production Worker bundle is minified", () => {
  // Same guard as the plugin's, in the same shape: deploy.mjs drives esbuild through its JS
  // API rather than its CLI, because the CLI has no portable spawn (see `localBin`).
  const source = readFileSync(fileURLToPath(new URL("./deploy.mjs", import.meta.url)), "utf8");
  assert.match(source, /minify:\s*true/);
});

test("a named deploy checks the Worker name before it creates anything", () => {
  // Order is the whole guarantee: the check has to run before the bucket is created and long
  // before `uploadScript`, which is a PUT that would replace an existing Worker's code,
  // bindings and cron. A refusal must leave nothing behind.
  const source = readFileSync(fileURLToPath(new URL("./deploy.mjs", import.meta.url)), "utf8");
  const checks = source.indexOf("await ensureWorkerScript(");
  const bucket = source.indexOf("await ensureR2Bucket(");
  const uploads = source.indexOf("await uploadScript(");

  assert.ok(checks > 0 && bucket > 0 && uploads > 0, "expected all three call sites");
  assert.ok(checks < bucket, "the Worker check must precede bucket creation");
  assert.ok(checks < uploads, "the Worker check must precede the upload");
  // Recorded ownership is what makes a redeploy free; adoption is the explicit way past it.
  assert.match(source, /owned: Boolean\(fileEnv\.WORKER_URL\?\.trim\(\)\)/);
  assert.match(source, /adopt: adoptWorker/);
});

test("the production plugin bundle is minified", () => {
  const source = readFileSync(fileURLToPath(new URL("../plugin/build.mjs", import.meta.url)), "utf8");
  assert.match(source, /minify:\s*true/);
});

test("the agent is opt-in, and never a side effect of deploying a vault", () => {
  // The agent is a second Worker holding the vault master key. If it could ride along on an
  // ordinary deploy, the key would reach a Worker secret without anyone asking for it.
  const source = readFileSync(fileURLToPath(new URL("./deploy.mjs", import.meta.url)), "utf8");
  assert.match(source, /const withAgent = argv\.includes\("--agent"\)/);
  // Default off at the library boundary too, not only at the CLI.
  assert.match(source, /withAgent = false/);
  assert.match(source, /agentWritable = false/);
});

test("--agent refuses production, before anything is created", () => {
  // Production keeps its identity in .env, not .env.<name>, and standing an agent over it
  // means putting the production master key in a Worker secret — whose precondition is an
  // open owner action. The refusal has to precede deployViaRest so nothing is left behind.
  const source = readFileSync(fileURLToPath(new URL("./deploy.mjs", import.meta.url)), "utf8");
  const guard = source.indexOf("--agent needs --vault");
  const deploys = source.indexOf("await deployViaRest(");
  assert.ok(guard > 0, "expected the production guard");
  assert.ok(deploys > 0, "expected the deploy call");
  assert.ok(guard < deploys, "the refusal must run before anything is deployed");
});

test("the agent deploy runs only after the vault deploy has succeeded", () => {
  // It reads the env file the vault deploy writes. Running it earlier would read a stale URL,
  // or none at all on a first deploy.
  const source = readFileSync(fileURLToPath(new URL("./deploy.mjs", import.meta.url)), "utf8");
  const deploys = source.indexOf("await deployViaRest(");
  const agent = source.indexOf('await import("./deploy-agent.mjs")');
  assert.ok(agent > deploys, "the agent import must follow the vault deploy");
});

test("the console names the handover file and never a credential", async () => {
  // The split that matters: scrollback and transcripts get identifiers, the 0600 file gets
  // the values. Printing half and naming a file for the other half was the old shape, and it
  // just made the operator paste from two places.
  const { mcpSetupInstructions } = await import("./deploy-agent.mjs");
  const text = mcpSetupInstructions({
    url: "https://a.example.workers.dev",
    agentEnvName: ".env.agent.v",
    writable: false,
    handoffFile: "DEPLOY-CREDENTIALS.v.txt",
    bearerPrint: "3f9a1c22",
  });
  assert.match(text, /DEPLOY-CREDENTIALS\.v\.txt/);
  assert.match(text, /3f9a1c22/);
  // A fingerprint identifies the run; it must not be mistaken for something pasteable.
  assert.match(text, /a hash/);
  assert.doesNotMatch(text, /Authorization/);
  // And it says what deleting the file does, because that is now a rotation decision.
  assert.match(text, /redeploy keeps the bearer/);
});

test("the handover section carries everything the connector form needs", async () => {
  const { mcpHandoffSection } = await import("./deploy-agent.mjs");
  const bearer = "b".repeat(64);
  const text = mcpHandoffSection({
    url: "https://a.example.workers.dev",
    bearer,
    writable: false,
    vaultUrl: "https://vault.example.workers.dev",
  });
  // The two halves that used to live apart: the endpoint and the value to paste.
  assert.match(text, /https:\/\/a\.example\.workers\.dev\/mcp/);
  assert.ok(text.includes(`Bearer ${bearer}`), "the header value must be complete and pasteable");
  assert.match(text, /including the word Bearer and the space/);
  // The traps that each cost an hour, per the connector guide.
  assert.match(text, /never \/sse/);
  assert.match(text, /redirect to another host drops the header/);
  assert.match(text, /immutable once created/);
  // 401 on an anonymous /mcp probe is correct, and reads as a broken deploy if unexplained.
  assert.match(text, /401, not 405/);
  assert.match(text, /read-only/);

  // The gated beta is the hard stop: without a "Request headers" section in the dialog there
  // is no supported path at all, and a user who is not told that hunts for a field that does
  // not exist. It has to come before the values, not after them.
  const gate = text.indexOf("Request headers");
  const values = text.indexOf("/mcp");
  assert.ok(gate > 0, "expected the request-headers beta caveat");
  assert.ok(gate < values, "the caveat must precede the values it gates");
  assert.match(text, /OAuth is not built/);

  // The custody trade, and the sync Worker named so the contrast is concrete.
  assert.match(text, /MASTER KEY/);
  assert.match(text, /reaches your model provider/);
  assert.match(text, /vault\.example\.workers\.dev/);
  assert.match(text, /AGENT\.md/);
});

test("the handover section names the writable deployment's extra ability", async () => {
  const { mcpHandoffSection } = await import("./deploy-agent.mjs");
  const args = { url: "https://a.example", bearer: "x", vaultUrl: "https://v.example" };
  const ro = mcpHandoffSection({ ...args, writable: false });
  const rw = mcpHandoffSection({ ...args, writable: true });
  assert.match(rw, /append, edit, write/);
  assert.doesNotMatch(ro, /append, edit, write/);
  // The consequence, not just the capability: no confirmation, history is the undo.
  assert.match(rw, /no confirmation/);
  assert.doesNotMatch(ro, /no confirmation/);
});

test("importing deploy-agent.mjs does not deploy anything", async () => {
  // It is imported by deploy.mjs --agent. A top-level main() would have deployed on import.
  const source = readFileSync(fileURLToPath(new URL("./deploy-agent.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /^main\(\)\.catch/m);
  assert.match(source, /const invokedDirectly = process\.argv\[1\]/);
});

test("a new agent deployment gets an unguessable script name", async () => {
  // The account subdomain is public — every setup link names it — so a fixed <vault>-agent is
  // one guess away for anyone who has seen a sync URL, and that hostname fronts the master key.
  const { randomAgentScriptName } = await import("./deploy-agent.mjs");
  const name = randomAgentScriptName("my-vault");
  assert.match(name, /^my-vault-agent-[a-z2-7]{8}$/);
  // Legal as a Worker name: lowercase alphanumerics and hyphens only.
  assert.match(name, /^[a-z0-9-]+$/);
  // The readable prefix is kept on purpose: obscurity buys nothing against someone who can
  // list the account's Workers, and "which Worker holds a master key" must stay answerable.
  assert.ok(name.startsWith("my-vault-agent-"));
});

test("the random suffix actually varies, and uses the full 40 bits", async () => {
  const { randomAgentScriptName } = await import("./deploy-agent.mjs");
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(randomAgentScriptName("v"));
  assert.ok(seen.size > 190, `expected near-unique names, got ${seen.size}/200`);

  // 5 bytes in, 8 base32 characters out, with no byte silently dropped: an off-by-one in the
  // bit loop would still "look random" while throwing away entropy.
  const all = randomAgentScriptName("v", () => Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]));
  assert.equal(all, "v-agent-77777777");
  const none = randomAgentScriptName("v", () => Buffer.from([0, 0, 0, 0, 0]));
  assert.equal(none, "v-agent-aaaaaaaa");
});

test("an existing agent deployment never gets a fresh random name", () => {
  // A redeploy that renamed itself would upload a SECOND Worker beside the live one and leave
  // the old script running, still holding the master key, with nothing pointing at it.
  const source = readFileSync(fileURLToPath(new URL("./deploy-agent.mjs", import.meta.url)), "utf8");
  // Recorded name wins over generation, and a pre-suffix deployment falls back to its legacy
  // name rather than generating one.
  assert.match(source, /agentEnv\.AGENT_SCRIPT \?\?/);
  assert.match(source, /agentEnv\.AGENT_URL \? `\$\{vault\}-agent` : randomAgentScriptName\(vault\)/);
  // And the chosen name is persisted, or the next run would generate again.
  assert.match(source, /AGENT_SCRIPT: scriptName/);

  // The env file has to be read before the name is chosen, or the recorded name cannot win.
  const read = source.indexOf("const agentEnv = existsSync(");
  const choose = source.indexOf("const scriptName =");
  assert.ok(read > 0 && choose > 0, "expected both");
  assert.ok(read < choose, "the recorded name must be read before the name is chosen");
});

test("the agent health endpoint does not identify itself", () => {
  // Unauthenticated. Naming the service confirmed to anyone who found the hostname that they
  // had found the endpoint fronting a vault master key; the smoke test only reads `ok`.
  const source = readFileSync(fileURLToPath(new URL("../agent/src/index.ts", import.meta.url)), "utf8");
  assert.match(source, /pathname === "\/health"/);
  assert.doesNotMatch(source, /Response\.json\(\{ ok: true, service:/);
});

test("the deploy names which master key it used, and never the key", () => {
  // The wrong vault's key gives an agent that authenticates perfectly and decrypts nothing —
  // found much later, and confusing on arrival. Naming the source makes it checkable at deploy
  // time; printing the key itself would put the whole vault in the operator's scrollback.
  const source = readFileSync(fileURLToPath(new URL("./deploy-agent.mjs", import.meta.url)), "utf8");
  assert.match(source, /master key from \$\{keySource\}/);
  assert.match(source, /never printed/);
  // The value reaches exactly one place: the Worker's secret binding.
  const logged = source.match(/log\(`[^`]*\$\{masterKey\}[^`]*`\)/);
  assert.equal(logged, null, "the master key must never be logged");
  assert.match(source, /name: "VAULT_MASTER_KEY", text: masterKey/);

  // `keySource` is a const in the same function scope as the line that logs it, so using it
  // before its declaration would be a TDZ ReferenceError at runtime — which `node --check`
  // does not catch, and which would abort the deploy after the credentials were read.
  const declaredAt = source.indexOf("const keySource =");
  const usedAt = source.indexOf("log(`master key from ${keySource}");
  assert.ok(declaredAt > 0 && usedAt > 0, "expected both the declaration and the log");
  assert.ok(declaredAt < usedAt, "keySource must be declared before it is logged");
});

test("the agent's timezone comes from this machine unless the vault names one", async () => {
  const { resolveDeployZone } = await import("./deploy-agent.mjs");
  // The Worker runs in a colo with no idea where the vault lives; the person deploying is
  // standing in the right timezone by definition.
  assert.equal(resolveDeployZone(undefined, "Asia/Tokyo"), "Asia/Tokyo");
  assert.equal(resolveDeployZone("", "Asia/Tokyo"), "Asia/Tokyo");
  // An explicit AGENT_TZ wins, trimmed.
  assert.equal(resolveDeployZone("  Europe/Berlin  ", "Asia/Tokyo"), "Europe/Berlin");
});

test("the agent deploy refuses a timezone name it cannot resolve", async () => {
  const { resolveDeployZone } = await import("./deploy-agent.mjs");
  // Refused here, while a human is watching. The agent itself falls back to UTC rather than
  // failing to start, so an unnoticed typo would be a wrong date on every row for months.
  assert.throws(() => resolveDeployZone("America/Atlantis"), /not a timezone name/);
  // A fixed offset is the tempting wrong answer: it cannot follow a DST transition.
  assert.throws(() => resolveDeployZone("GMT+7"), /not a timezone name/);
  // And the trap worth a rule of its own: ICU RESOLVES the old abbreviations, and resolves
  // "EST" to America/Panama — a zone that never observes DST. Accepting it would put the
  // vault an hour out for eight months of the year, silently.
  assert.throws(() => resolveDeployZone("EST"), /abbreviation, not a zone.*America\/Panama/s);
  assert.throws(() => resolveDeployZone("PST"), /abbreviation, not a zone/);
  // UTC is the one bare name that means what it says.
  assert.equal(resolveDeployZone("UTC"), "UTC");
});

test("the timezone is uploaded as a binding the agent can read", () => {
  const source = readFileSync(fileURLToPath(new URL("./deploy-agent.mjs", import.meta.url)), "utf8");
  // plain_text, not secret_text: a zone name is not a credential, and a plain binding is
  // readable in the dashboard when a date looks wrong.
  assert.match(source, /\{ type: "plain_text", name: "AGENT_TZ", text: timezone \}/);
  // Resolved before the upload metadata is built, so an unknown name aborts having changed
  // nothing at all.
  assert.ok(source.indexOf("const timezone = resolveDeployZone(") < source.indexOf('name: "AGENT_TZ"'));
});

test("a redeploy retires the token pair it replaced, and nothing else", async () => {
  const { supersededTokenIds } = await import("./deploy-agent.mjs");
  // The ordinary redeploy: both recorded ids go, once the new ones are live.
  assert.deepEqual(
    supersededTokenIds({ READ_TOKEN_ID: "old-r", WRITE_TOKEN_ID: "old-w" }, ["new-r", "new-w"]),
    ["old-r", "old-w"]
  );
  // A first deploy has nothing to retire.
  assert.deepEqual(supersededTokenIds({}, ["new-r"]), []);
  assert.deepEqual(supersededTokenIds({ READ_TOKEN_ID: "", WRITE_TOKEN_ID: "" }, ["new-r"]), []);
  // A read-only redeploy over a writable one withdraws the write token: that IS the change.
  assert.deepEqual(
    supersededTokenIds({ READ_TOKEN_ID: "old-r", WRITE_TOKEN_ID: "old-w" }, ["new-r"]),
    ["old-r", "old-w"]
  );
  // And it never revokes a credential this very run minted — that would be a deployment
  // destroying its own agent.
  assert.deepEqual(
    supersededTokenIds({ READ_TOKEN_ID: "same", WRITE_TOKEN_ID: "old-w" }, ["same", "new-w"]),
    ["old-w"]
  );
});

test("a failed agent deploy leaves no vault credential behind", () => {
  // P1 of the 2026-08-31 security review. These are permanent unexpiring credentials for the
  // whole vault, minted before the upload, and a failure recorded no id anywhere — so a broken
  // deploy used to leave a live token nothing could name afterwards.
  const source = readFileSync(fileURLToPath(new URL("./deploy-agent.mjs", import.meta.url)), "utf8");
  // Every mint is tracked, and the tracking is what the rollback iterates.
  assert.match(source, /minted\.push\(tokenIdOf\(token\)\)/);
  assert.match(source, /for \(const id of minted\)/);
  // The guarded region starts at the first mint and ends no earlier than the health check.
  const guard = source.indexOf("  try {");
  assert.ok(guard < source.indexOf('log("minting a read-only vault token'), "mint must be inside the try");
  assert.ok(source.indexOf("await waitForHealth(") < source.indexOf("  } catch (error) {"), "health check must be inside the try");
});

test("superseded tokens are revoked only after the new deployment is recorded and healthy", () => {
  const source = readFileSync(fileURLToPath(new URL("./deploy-agent.mjs", import.meta.url)), "utf8");
  // Revoking before /health would blind a working agent to save a failed deploy; revoking
  // before the env file is written would risk losing the ids of the credentials now in use.
  const health = source.indexOf("await waitForHealth(");
  const record = source.indexOf("READ_TOKEN_ID: tokenIdOf(readToken)");
  const retire = source.indexOf("const superseded = supersededTokenIds(");
  assert.ok(health < record, "env file is written after the smoke test");
  assert.ok(record < retire, "superseded tokens are retired after the new ids are on disk");
  // A revocation that fails is reported by id, because nothing else can name it afterwards.
  assert.match(source, /COULD NOT REVOKE/);
});

test("the handover file's presence is what decides rotation", async () => {
  const { handoffPath, handoffPending, writeHandoff } = await import("./setup-lib.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-"));

  // Nothing handed over yet: a deploy is free to issue fresh credentials.
  assert.equal(handoffPending(dir, "v"), false);
  const file = writeHandoff(dir, "v", ["  SECTION"]);
  assert.equal(file, handoffPath(dir, "v"));
  // Now there is an uncollected document naming live credentials. Rotating under it would
  // leave the operator holding a file that no longer opens anything.
  assert.equal(handoffPending(dir, "v"), true);

  // Per deployment, not global: a named vault's file says nothing about production's.
  assert.equal(handoffPending(dir, null), false);
  assert.notEqual(handoffPath(dir, null), handoffPath(dir, "v"));

  // Collected and removed — the next deploy rotates.
  rmSync(file);
  assert.equal(handoffPending(dir, "v"), false);
  rmSync(dir, { recursive: true });
});

test("the handover file is 0600 and says what to do with itself", async () => {
  const { writeHandoff } = await import("./setup-lib.mjs");
  const dir = mkdtempSync(path.join(tmpdir(), "handoff-"));
  const file = writeHandoff(dir, null, ["  VALUES"]);
  // It is plaintext credentials on disk; the mode is the only thing standing between it and
  // every other process running as this user.
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(file, "utf8");
  assert.match(text, /VALUES/);
  // Instructions, not just data: store it, then delete it, and what deleting it causes.
  assert.match(text, /password manager/);
  assert.match(text, new RegExp(`rm ${path.basename(file)}`));
  assert.match(text, /a redeploy KEEPS every credential named in it/);
  assert.match(text, /removing and re-adding the connector/);
  rmSync(dir, { recursive: true });
});

test("a fingerprint identifies a run without leaking the credential", async () => {
  const { fingerprint } = await import("./setup-lib.mjs");
  const a = fingerprint("b".repeat(64));
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(a, fingerprint("b".repeat(64)));
  assert.notEqual(a, fingerprint("c".repeat(64)));
  // Eight hex characters of SHA-256: enough to tell two deploys apart, useless for recovery.
  assert.ok(!"b".repeat(64).includes(a));
});
