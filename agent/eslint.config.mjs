// Typed lint for the agent Worker.
//
// Its own config rather than the sync Worker's, because its `include` is different: this
// package imports `../plugin/src/*` directly, and those files are checked against
// workers-types (no DOM) as a side effect. Only this package's own sources are linted —
// the plugin lints itself, under its own rules, and linting it twice under two configs
// would produce findings nobody can act on from here.
//
// Keep this at zero findings, like the other two, so a new nonzero exit means something new.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", ".wrangler/**", "vitest.config.ts"] },

  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Durable Object RPC methods must return promises whether or not their body awaits.
      "@typescript-eslint/require-await": "off",
    },
  },

  {
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-unnecessary-type-assertion": "off" },
  }
);
