#!/usr/bin/env node
// The comparator half of the timing benchmark (plan.md, 2026-08-15): a faithful replay of the
// per-file object-store protocol that remotely-save (and any rclone/S3-style sync) runs, against
// the naive store Worker from scripts/bench-naive.mjs.
//
// The pass shapes modelled, each deliberately favourable to the comparator:
//   every pass:  LIST the whole remote (paged 1000) + GET the metadata JSON
//   cold upload: PUT every file, concurrency 5, then PUT metadata
//   no-op pass:  nothing further — not even the metadata write remotely-save sometimes does
//   one edit:    PUT the file + PUT metadata
//   cold join:   GET every file, concurrency 5
//   rename x50:  DELETE 50 + PUT 50 + PUT metadata (a per-file protocol cannot dedup a rename)
// No folder markers, no encryption, plain JSON metadata. What it keeps is the structure that
// costs: a full listing every pass and one request per changed file.
//
//   node scripts/bench-naive-client.mjs <vault-dir> [--out results.json]
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renamePlan } from "./bench-vault.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONCURRENCY = 5; // remotely-save's transfer queue width
const META_KEY = "_remotely-save-metadata-on-remote.json";

// ---------------------------------------------------------------------------
// Store access with counters
// ---------------------------------------------------------------------------

function credentials() {
  let url = process.env.R2DO_NAIVE_URL?.trim();
  let token = process.env.R2DO_NAIVE_TOKEN?.trim();
  if (!url || !token) {
    const file = path.join(ROOT, "testvault", ".env.sandbox-naive");
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      throw new Error(`no naive-store credentials: set R2DO_NAIVE_URL/R2DO_NAIVE_TOKEN or run scripts/bench-naive.mjs`);
    }
    for (const line of text.split("\n")) {
      const at = line.indexOf("=");
      if (at <= 0 || line.startsWith("#")) continue;
      const key = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      if (key === "R2DO_NAIVE_URL") url ??= value;
      if (key === "R2DO_NAIVE_TOKEN") token ??= value;
    }
  }
  if (!url || !token) throw new Error("naive-store credential file is missing R2DO_NAIVE_URL or R2DO_NAIVE_TOKEN");
  return { url, token };
}

const { url: BASE, token: TOKEN } = credentials();
const counters = { requests: 0, bytesUp: 0, bytesDown: 0 };

async function call(method, pathname, body) {
  counters.requests += 1;
  if (body !== undefined) counters.bytesUp += body.byteLength;
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}` },
    body,
  });
  const buffer = new Uint8Array(await res.arrayBuffer());
  counters.bytesDown += buffer.byteLength;
  // Every read here is of something an earlier step wrote, so a 404 is a broken benchmark, not
  // an empty answer. It used to be tolerated on GET, which meant a missing object recorded a
  // fast, tiny, "successful" timing — a comparison invalidated in the direction that flatters
  // the comparator, and silently. No caller inspects the status, so there is nothing to soften.
  if (!res.ok) {
    throw new Error(`${method} ${pathname} failed with HTTP ${res.status}`);
  }
  return { status: res.status, buffer };
}

const putObject = (key, body) => call("PUT", `/o/${encodeURIComponent(key)}`, body);
const getObject = (key) => call("GET", `/o/${encodeURIComponent(key)}`);
const deleteObject = (key) => call("DELETE", `/o/${encodeURIComponent(key)}`);

async function listAll() {
  const objects = [];
  let cursor = null;
  do {
    const query = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const { buffer } = await call("GET", `/list${query}`);
    const page = JSON.parse(new TextDecoder().decode(buffer));
    objects.push(...page.objects);
    cursor = page.cursor;
  } while (cursor !== null);
  return objects;
}

async function pool(items, worker) {
  const queue = [...items];
  const lanes = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

// ---------------------------------------------------------------------------
// The vault, in memory
// ---------------------------------------------------------------------------

function readVault(dir) {
  const out = new Map();
  const walk = (prefix) => {
    for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) out.set(rel, new Uint8Array(readFileSync(path.join(dir, rel))));
    }
  };
  walk("");
  return out;
}

function metaBody(vault) {
  const entries = {};
  for (const [rel, bytes] of [...vault.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    entries[rel] = { size: bytes.byteLength, mtime: 1_755_200_000_000 };
  }
  return new TextEncoder().encode(JSON.stringify(entries));
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function measure(fn) {
  const before = { ...counters };
  const start = performance.now();
  await fn();
  return {
    ms: Math.round(performance.now() - start),
    requests: counters.requests - before.requests,
    bytesUp: counters.bytesUp - before.bytesUp,
    bytesDown: counters.bytesDown - before.bytesDown,
  };
}

const median = (runs) => {
  const sorted = [...runs].sort((a, b) => a.ms - b.ms);
  return { ...sorted[Math.floor(sorted.length / 2)], runs: runs.map((r) => r.ms) };
};

async function main() {
  const argv = process.argv.slice(2);
  const dir = argv.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("usage: node scripts/bench-naive-client.mjs <vault-dir> [--out results.json]");
    process.exit(1);
  }
  const outFile = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : null;

  const vault = readVault(dir);
  if (vault.size === 0) throw new Error(`no files under ${dir}`);
  console.log(`vault: ${vault.size} files, ${([...vault.values()].reduce((n, b) => n + b.byteLength, 0) / 1024 / 1024).toFixed(1)} MiB`);
  const existing = await listAll();
  if (existing.length > 0) throw new Error(`store is not empty (${existing.length} objects) — S1 must start cold`);

  const results = {};
  const editTarget = [...vault.keys()].sort((a, b) => (a < b ? -1 : 1))[Math.floor(vault.size / 2)];

  // S1 — cold first sync: list (empty), upload everything, write metadata.
  results.s1_cold_upload = await measure(async () => {
    await listAll();
    await pool([...vault.entries()], ([rel, bytes]) => putObject(rel, bytes));
    await putObject(META_KEY, metaBody(vault));
  });
  console.log("S1 done", results.s1_cold_upload);

  // S2 — no-change pass: the steady-state cost, three times.
  {
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      runs.push(
        await measure(async () => {
          await listAll();
          await getObject(META_KEY);
        })
      );
    }
    results.s2_noop_pass = median(runs);
    console.log("S2 done", results.s2_noop_pass);
  }

  // S3 — one-file edit pass, three times with distinct contents.
  {
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      const edited = new TextEncoder().encode(`${new TextDecoder().decode(vault.get(editTarget))}\nedit ${i}\n`);
      vault.set(editTarget, edited);
      runs.push(
        await measure(async () => {
          await listAll();
          await getObject(META_KEY);
          await putObject(editTarget, edited);
          await putObject(META_KEY, metaBody(vault));
        })
      );
    }
    results.s3_one_edit = median(runs);
    console.log("S3 done", results.s3_one_edit);
  }

  // S4 — second device cold join: download everything.
  results.s4_cold_join = await measure(async () => {
    const listed = await listAll();
    await getObject(META_KEY);
    await pool(
      listed.filter((o) => o.key !== META_KEY),
      (o) => getObject(o.key)
    );
  });
  console.log("S4 done", results.s4_cold_join);

  // S5 — propagation: the edit pass on device A, then device B's pass picking up one file.
  {
    const edited = new TextEncoder().encode(`${new TextDecoder().decode(vault.get(editTarget))}\npropagate\n`);
    vault.set(editTarget, edited);
    const sideA = await measure(async () => {
      await listAll();
      await getObject(META_KEY);
      await putObject(editTarget, edited);
      await putObject(META_KEY, metaBody(vault));
    });
    const sideB = await measure(async () => {
      await listAll();
      await getObject(META_KEY);
      await getObject(editTarget);
    });
    results.s5_propagation = { ms: sideA.ms + sideB.ms, sideA, sideB };
    console.log("S5 done", results.s5_propagation);
  }

  // S6 — rename a 50-file folder: a per-file protocol re-moves every byte.
  {
    const plan = renamePlan(new Map([...vault].map(([k, v]) => [k, new TextDecoder().decode(v)])), 50);
    results.s6_rename_50 = await measure(async () => {
      await listAll();
      await getObject(META_KEY);
      await pool(plan, async (move) => {
        const bytes = vault.get(move.from);
        await putObject(move.to, bytes);
        await deleteObject(move.from);
      });
      for (const move of plan) {
        const bytes = vault.get(move.from);
        vault.delete(move.from);
        vault.set(move.to, bytes);
      }
      await putObject(META_KEY, metaBody(vault));
    });
    console.log("S6 done", results.s6_rename_50);
  }

  console.log(JSON.stringify(results, null, 2));
  if (outFile) {
    writeFileSync(outFile, JSON.stringify({ system: "naive-per-file-replay", concurrency: CONCURRENCY, files: vault.size, results }, null, 2));
    console.log(`wrote ${outFile}`);
  }
}

await main();
