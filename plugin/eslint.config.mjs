// Typed lint for the plugin package.
//
// This exists to reproduce — and refute — automated review reports locally. The community
// review bot's report on 0.1.8 carried ~1500 `no-unsafe-*` warnings that were all ONE finding:
// its rules ran without resolving `obsidian`, so every value crossing that import became
// TypeScript's internal `error` type, which behaves as `any`, and everything derived from it
// was "unsafe". Run against this package's own tsconfig — where `obsidian` resolves — the same
// rules report ten things in `src/`, not fifteen hundred.
//
// `tsc --noEmit` being clean is NOT the same check. These rules are about `any` flowing
// through code that typechecks perfectly well, which is why they found a real one: the
// `requestUrl` adapter in `main.ts` was handing Obsidian's `any` back through an interface
// that promises `unknown`.
//
// `eslint-plugin-obsidianmd` is deliberately NOT a dependency here. It pulls 227 extra
// packages, including a second eslint, a second TypeScript and a second `obsidian` nested in
// this package, and `npm ci --prefix plugin` is what the release workflow runs before it
// attests the published assets. Its rules are also the ones the bot reports *accurately*,
// since they read local types only. Install it ad hoc if a future report needs refuting.
//
// Keep this at zero findings. A lint that always fails is a lint nobody reads, and the whole
// point is that a NEW nonzero exit means something actually happened.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Untyped tooling and build output. These must never reach a typed rule: `build.mjs` and
  // `vitest.config.ts` sit outside tsconfig's `include`, and a typed rule on a file no
  // project covers fails the whole run rather than skipping the file.
  { ignores: ["dist/**", "build.mjs", "vitest.config.ts"] },

  {
    // Exactly tsconfig.json's `include`.
    files: ["src/**/*.ts", "test/**/*.ts"],
    // Core rules first: typescript-eslint's config switches off the base rules it replaces,
    // so it has to come second. Core is worth having for `no-control-regex` alone — two
    // `eslint-disable` comments in this repo exist for it, and without the rule actually
    // enabled they read as unused directives, which is worse than not checking at all.
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `async` is an interface contract here, not an oversight: Obsidian method overrides,
      // the fetch-shaped `HttpResponse` adapter over `requestUrl`, and modal handlers must
      // return promises whether or not their body happens to await one. The rule cannot see
      // that; it reported eleven such sites across both packages and nothing else.
      "@typescript-eslint/require-await": "off",
    },
  },

  {
    // Tests drive a recording stand-in for the `obsidian` module (aliased in
    // `vitest.config.ts`) and deliberately read back values its typings call `any`. The
    // hazard these rules guard against — unvalidated `any` reaching production logic — is not
    // present, and the assertions are themselves the check. Left ON in `src/`, where it is.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      // Off here because its autofix demonstrably broke the build: this tsconfig sets
      // `types: ["vitest/globals"]`, which leaves `@types/node` out of the program, so
      // `restore.spec.ts`'s assertions on `await import("node:fs/promises")` are the only
      // reason those imports have types at all. The rule cannot see that and removed them.
      // Kept ON in `src/`, where it correctly found three removable assertions.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
    },
  }
);
