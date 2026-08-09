// Typed lint for the Worker package.
//
// Separate from the plugin's config on purpose. These are server sources, and the Obsidian
// *plugin* guidelines the review bot applies to the whole repository do not govern them — its
// "avoid unnecessary logging" findings on `gc.ts` and `index.ts` are describing how a Worker
// is diagnosed.
//
// What is worth running here is the typed rules, against the tsconfig that actually loads
// `@cloudflare/workers-types`. That is how the two `(await obj.json()) as Manifest`
// assertions in `gc.ts` and `vault-lock.ts` turned out to be genuinely removable — the bot
// was right about them, just not in the way it suggested. `json<T>()` has an unconstrained
// type parameter with no inference site, so the assertion was the only thing choosing `T`;
// replacing it with an explicit annotation is what actually works. An explicit type argument
// does not: `gc.ts` imports `Env` from `index.ts`, which imports `gc.ts` back, and that cycle
// collapses to TS7022 the moment the annotation is gone.
//
// Keep this at zero findings, so a new nonzero exit means something new happened.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Build output, wrangler's local state, and the untyped vitest config — the last sits
  // outside tsconfig's `include`, and a typed rule on an uncovered file fails the run.
  { ignores: ["dist/**", ".wrangler/**", "vitest.config.ts"] },

  {
    // Exactly tsconfig.json's `include`.
    files: ["src/**/*.ts", "test/**/*.ts"],
    // Core rules first — typescript-eslint's config disables the base rules it replaces, so
    // it must come second. Core carries `no-control-regex`, which `manifest.ts` has a
    // described `eslint-disable` for; without the rule on, that comment reads as unused.
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Durable Object RPC methods and `blockConcurrencyWhile` callbacks have to return
      // promises regardless of whether their body awaits anything. See the plugin config.
      "@typescript-eslint/require-await": "off",
    },
  },

  {
    // Same story as the plugin's test override: this rule's autofix broke `settings.spec.ts`
    // in three places, where the assertions are what narrow an `unknown` response body.
    // Kept ON in `src/` — that is where it earned its keep.
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-unnecessary-type-assertion": "off" },
  }
);
