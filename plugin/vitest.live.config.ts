import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * The live suite: the real plugin against a deployed sandbox Worker and real files on disk.
 * Separate from the default project because it needs credentials and a network, and because
 * `npm test` must stay runnable — and meaningful — with neither.
 *
 * Single-threaded and generous on time on purpose. Each group has its own deployed Worker —
 * one deployment is one vault with one head (`getByName("default")`), so groups that reroot,
 * re-key or force-push would otherwise invalidate each other's assumptions rather than run
 * independently. Isolation makes concurrency *possible*; it is still not taken, because
 * parallel suites contend for the same origin's connections and starve the plugin's own
 * in-flight commits — which surfaces as timeouts that look like plugin bugs and are not.
 */
export default defineConfig({
  resolve: {
    alias: {
      obsidian: path.resolve(import.meta.dirname, "test/obsidian-fake.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/live/**/*.spec.ts"],
    setupFiles: ["test/live/setup.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
