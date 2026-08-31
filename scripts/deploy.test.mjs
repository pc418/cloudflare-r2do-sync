import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
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

test("MCP setup instructions name the file, never the bearer itself", async () => {
  // The bearer is a credential to a process holding the master key. Printing it would put it
  // in terminal scrollback and in any transcript of the deploy.
  const { mcpSetupInstructions } = await import("./deploy-agent.mjs");
  const text = mcpSetupInstructions({
    url: "https://a.example.workers.dev",
    agentEnvName: ".env.agent.v",
    writable: false,
  });
  assert.match(text, /https:\/\/a\.example\.workers\.dev\/mcp/);
  assert.match(text, /Authorization: Bearer <MCP_BEARER from \.env\.agent\.v>/);
  assert.match(text, /must include the word "Bearer" and the space/);
  // The traps that each cost an hour, per the connector guide.
  assert.match(text, /never \/sse/);
  assert.match(text, /redirect to another host drops the header/);
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

  // A way to get the 64-char token out without it landing in scrollback, and a way to check
  // the deployment before trusting it.
  assert.match(text, /pbcopy/);
  assert.match(text, /agent-mcp-verify\.mjs/);

  // The custody trade. `deploy.mjs --agent` says it on the confirmation screen; someone
  // running this script directly never sees that screen.
  assert.match(text, /MASTER KEY/);
  assert.match(text, /reaches your model provider/);

  // The standing-instructions note, and the one thing about it that surprises people.
  assert.match(text, /AGENT\.md/);
  assert.match(text, /NEXT conversation/);
});

test("the setup text names the writable deployment's extra ability", async () => {
  const { mcpSetupInstructions } = await import("./deploy-agent.mjs");
  const ro = mcpSetupInstructions({ url: "https://a.example", agentEnvName: ".env.agent.v", writable: false });
  const rw = mcpSetupInstructions({ url: "https://a.example", agentEnvName: ".env.agent.v", writable: true });
  assert.match(rw, /this deployment can edit it itself/);
  assert.doesNotMatch(ro, /this deployment can edit it itself/);
  assert.match(rw, /append, edit, write/);
  assert.doesNotMatch(ro, /append, edit, write/);
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
