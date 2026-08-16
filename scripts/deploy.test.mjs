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
