import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { ADMIN_TOKEN: "test-admin-token" } },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
