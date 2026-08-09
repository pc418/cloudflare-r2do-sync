import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // The plugin imports the real `obsidian` module, which only exists inside the app.
      // Tests get a recording stand-in so UI rendering is covered outside Obsidian.
      obsidian: path.resolve(import.meta.dirname, "test/obsidian-fake.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
  },
});
