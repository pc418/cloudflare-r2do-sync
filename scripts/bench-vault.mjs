#!/usr/bin/env node
// Deterministic synthetic vault for the sync timing benchmark (plan.md, 2026-08-15).
//
// Both runners — the real plugin through the live harness and the remotely-save protocol
// replay — must sync EXACTLY the same bytes, or the comparison measures the vaults instead of
// the protocols. So the vault is a pure function of the seed, written to disk once and read
// by both.
//
//   node scripts/bench-vault.mjs <dir> [--files 800] [--seed 1]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Deterministic PRNG (mulberry32): same seed, same vault, on every platform. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ["ta", "ri", "mo", "ken", "lu", "va", "so", "ne", "pi", "dor", "al", "es", "un", "chi", "ba", "ro"];

function word(rng) {
  let out = "";
  const n = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i += 1) out += SYLLABLES[Math.floor(rng() * SYLLABLES.length)];
  return out;
}

function line(rng) {
  const words = [];
  const n = 4 + Math.floor(rng() * 10);
  for (let i = 0; i < n; i += 1) words.push(word(rng));
  return words.join(" ");
}

/**
 * path → contents. `files` markdown notes across nested folders.
 *
 * Sizes are 200 B … 120 KB with a long-tail spread (200·600^u for uniform u), mean ~19 KB —
 * a plausible note distribution that lands an 800-file vault near 15 MB, the scale of the
 * real vault this project syncs (854 tracked entries).
 */
export function generateVault({ files = 800, seed = 1 } = {}) {
  const rng = mulberry32(seed);
  const folders = [
    "",
    "daily",
    "projects",
    "projects/alpha",
    "projects/beta",
    "reference",
    "reference/papers",
    "journal",
    "journal/2026",
    "inbox",
  ];
  const out = new Map();
  for (let i = 0; i < files; i += 1) {
    const folder = folders[Math.floor(rng() * folders.length)];
    const name = `${word(rng)}-${i}.md`;
    const rel = folder === "" ? name : `${folder}/${name}`;
    const target = Math.floor(200 * 600 ** rng());
    let body = `# ${word(rng)} ${i}\n\n`;
    while (body.length < target) body += `${line(rng)}\n`;
    out.set(rel, body);
  }
  return out;
}

/**
 * The S6 rename mapping, derived from the vault rather than passed around: the first 50 paths
 * in sort order move to `renamed/<basename>`. Both runners compute it from the same vault, so
 * they perform the identical rename. Basenames carry the file's index, so they cannot collide.
 */
export function renamePlan(vault, count = 50) {
  const paths = [...vault.keys()].sort((a, b) => (a < b ? -1 : 1)).slice(0, count);
  return paths.map((from) => ({ from, to: `renamed/${path.posix.basename(from)}` }));
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const dir = argv.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("usage: node scripts/bench-vault.mjs <dir> [--files 800] [--seed 1]");
    process.exit(1);
  }
  const flag = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    if (at === -1) return fallback;
    const value = Number(argv[at + 1]);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} needs a positive integer`);
    return value;
  };
  const vault = generateVault({ files: flag("files", 800), seed: flag("seed", 1) });
  rmSync(dir, { recursive: true, force: true });
  let total = 0;
  for (const [rel, contents] of vault) {
    const full = path.resolve(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
    total += Buffer.byteLength(contents);
  }
  console.log(`wrote ${vault.size} files, ${(total / 1024 / 1024).toFixed(1)} MiB → ${dir}`);
}
