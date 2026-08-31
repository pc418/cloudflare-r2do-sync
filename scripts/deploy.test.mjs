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
});

test("importing deploy-agent.mjs does not deploy anything", async () => {
  // It is imported by deploy.mjs --agent. A top-level main() would have deployed on import.
  const source = readFileSync(fileURLToPath(new URL("./deploy-agent.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /^main\(\)\.catch/m);
  assert.match(source, /const invokedDirectly = process\.argv\[1\]/);
});
