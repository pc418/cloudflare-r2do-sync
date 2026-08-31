// Mirror of the Obsidian community scorecard's lint, so its numbers can be reproduced and
// (where wrong) refuted with evidence instead of argument.
//
// This deliberately reproduces the scanner's `recommended` defaults rather than this repo's
// considered configuration — the point is to see what the card sees. For the repo's own
// ground-truth lint, use `npm run lint` in plugin/, worker/ and agent/, whose baselines are
// zero. Background and the per-finding disposition:
// `docs/260830-eval-COMMUNITY_SCORECARD_2930_TRIAGE.md`.
//
// `eslint-plugin-obsidianmd` is NOT a dependency of any package here: it pulls ~227 extra
// packages including a second eslint, TypeScript and `obsidian`, and `npm ci --prefix plugin`
// is what the release workflow runs before it attests the published assets (decision recorded
// 2026-08-08). Install it somewhere scratch instead:
//
//   mkdir -p /tmp/obsidian-scan && cd /tmp/obsidian-scan && npm init -y
//   npm i -D eslint typescript-eslint typescript eslint-plugin-obsidianmd
//   cp /path/to/this/repo/scripts/community-scan.config.mjs /tmp/obsidian-scan/
//   cd /path/to/this/repo
//   /tmp/obsidian-scan/node_modules/.bin/eslint plugin/src worker/src agent/src \
//     --config /tmp/obsidian-scan/community-scan.config.mjs
//
// The copy is not optional: ESLint resolves a config's own `import`s relative to the config
// file, so this has to sit beside the `node_modules` holding the plugin. It reads the repo
// through `process.cwd()` instead of its own path, which is what makes that copy harmless —
// run it from the repo root.
//
// **Run it with dependencies installed.** The single most important fact about the scorecard
// is that it lints without them: `obsidian` and `@cloudflare/workers-types` then fail to
// resolve, every value crossing those imports decays to `any`, and the `no-unsafe-*` rules
// cascade. Measured 2026-08-30 on tag 0.9.2, plugin/src + worker/src: 2,976 findings without
// installed types, 77 with. The card said ~2,930.

import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**"] },
  ...obsidianmd.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
    },
    // Left at defaults on purpose. `ui/sentence-case` accepts `brands` and `acronyms`
    // options, and ["R2DO Sync"] / ["QR"] would clear 23 of its 24 findings here — but the
    // scanner does not read this file, so configuring them would only hide from us what the
    // card still reports.
  }
);
