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

test("the production plugin bundle is minified", () => {
  const source = readFileSync(fileURLToPath(new URL("../plugin/build.mjs", import.meta.url)), "utf8");
  assert.match(source, /minify:\s*true/);
});
