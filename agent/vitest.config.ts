import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          MCP_BEARER: "test-mcp-bearer",
          // A syntactically real key: `VaultCrypto` validates the format, so a placeholder
          // string would fail before any test reached the behaviour under test.
          VAULT_MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          SYNC_URL: "https://sync.invalid",
          SYNC_TOKEN: "read-only-token",
        },
      },
    }),
  ],
});
