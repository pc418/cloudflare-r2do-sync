#!/usr/bin/env node
// Copies the built plugin into an Obsidian vault.
//   node scripts/install-plugin.mjs "/path/to/Vault"
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "plugin", "dist");
const vault = process.argv[2];

if (!vault) {
  console.error('usage: node scripts/install-plugin.mjs "/path/to/Vault"');
  process.exit(2);
}
if (!existsSync(path.join(vault, ".obsidian"))) {
  console.error(`not an Obsidian vault (no .obsidian directory): ${vault}`);
  process.exit(1);
}
if (!existsSync(path.join(DIST, "main.js"))) {
  console.error("plugin not built — run: cd plugin && node build.mjs");
  process.exit(1);
}

const target = path.join(vault, ".obsidian", "plugins", "cloudflare-rdo-sync");
mkdirSync(target, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  copyFileSync(path.join(DIST, file), path.join(target, file));
}
console.log(`installed -> ${target}`);
console.log("Enable it in Obsidian: Settings → Community plugins → R2DO Sync.");
