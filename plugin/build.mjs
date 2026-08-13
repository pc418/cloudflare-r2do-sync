import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(DIR);
const OUT = path.join(DIR, "dist");
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: [path.join(DIR, "src/main.ts")],
  bundle: true,
  // Obsidian loads plugins as CommonJS and provides `obsidian` at runtime.
  format: "cjs",
  platform: "browser",
  target: "es2018",
  external: ["obsidian", "electron"],
  outfile: path.join(OUT, "main.js"),
  sourcemap: false,
  minify: true,
  logLevel: "info",
});

copyFileSync(path.join(ROOT, "manifest.json"), path.join(OUT, "manifest.json"));
copyFileSync(path.join(DIR, "styles.css"), path.join(OUT, "styles.css"));
console.log(`built -> ${OUT}`);
