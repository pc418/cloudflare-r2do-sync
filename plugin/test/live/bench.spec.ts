// Timing benchmark: the real plugin against a sandbox Worker (plan.md, 2026-08-15).
//
// Not a test of correctness — the 78-test live suite owns that — but a measurement harness for
// the scenarios a user feels, with request/byte counters wrapped around the live HTTP shim.
// The comparator half (the remotely-save protocol replay) is scripts/bench-naive-client.mjs;
// both sides sync the byte-identical vault from scripts/bench-vault.mjs.
//
// Opt-in twice over: it needs `R2DO_BENCH=1` AND the `bench` / `bench-e` sandboxes, so an
// ordinary `npm run test:live` never pays for it. Scenario order matters (S4's cold join
// downloads what S1 uploaded), so everything runs in one sequential file.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Notice, requestUrlMock } from "../obsidian-fake";
import { generateMasterKey, generateVaultSalt } from "../../src/crypto";
import { LiveHarness, liveConfig, vaultRoot, type LiveConfig } from "./harness";

const enabled = process.env.R2DO_BENCH === "1";
const config = enabled ? liveConfig("bench") : null;
const encConfig = enabled ? liveConfig("bench-e") : null;

const LONG = { timeout: 900_000 };

// ---------------------------------------------------------------------------
// Shared vault + instrumentation
// ---------------------------------------------------------------------------

function benchVaultDir(): string {
  return process.env.R2DO_BENCH_VAULT?.trim() || path.join(vaultRoot(), "bench-vault");
}

function readVault(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (prefix: string): void => {
    for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) out[rel] = readFileSync(path.join(dir, rel), "utf8");
    }
  };
  walk("");
  return out;
}

/** Byte-order sort, NOT localeCompare: must match scripts/bench-vault.mjs `renamePlan`. */
const byteSorted = (paths: string[]): string[] => [...paths].sort((a, b) => (a < b ? -1 : 1));

/** First 50 paths move to `renamed/<basename>` — the same plan the replay client executes. */
function renamePlan(paths: string[], count = 50): { from: string; to: string }[] {
  return byteSorted(paths)
    .slice(0, count)
    .map((from) => ({ from, to: `renamed/${path.posix.basename(from)}` }));
}

interface Counter {
  requests: number;
  bytesUp: number;
  bytesDown: number;
  blobPuts: number;
}

/**
 * Wraps whatever `installLiveHttp` installed. Must be re-applied after every
 * `LiveHarness.start`, which replaces the implementation wholesale.
 */
function instrument(): Counter {
  const inner = requestUrlMock.impl;
  if (inner === null) throw new Error("live HTTP is not installed — instrument() must follow LiveHarness.start");
  const counter: Counter = { requests: 0, bytesUp: 0, bytesDown: 0, blobPuts: 0 };
  requestUrlMock.impl = async (req: unknown) => {
    const { url, method, body } = req as { url: string; method?: string; body?: string | ArrayBuffer };
    counter.requests += 1;
    if (typeof body === "string") counter.bytesUp += Buffer.byteLength(body);
    else if (body instanceof ArrayBuffer) counter.bytesUp += body.byteLength;
    if ((method ?? "GET").toUpperCase() === "PUT" && url.includes("/api/blobs/")) counter.blobPuts += 1;
    const res = (await inner(req)) as { arrayBuffer: ArrayBuffer };
    counter.bytesDown += res.arrayBuffer.byteLength;
    return res;
  };
  return counter;
}

interface Measurement {
  ms: number;
  requests: number;
  bytesUp: number;
  bytesDown: number;
  blobPuts: number;
}

/** One timed `syncNow`, with a fail-loud check: a pass that errored must not report a time. */
async function timedPass(harness: LiveHarness, counter: Counter): Promise<Measurement> {
  const before = { ...counter };
  const noticesBefore = Notice.shown.length;
  const start = performance.now();
  await harness.plugin.syncNow();
  const ms = Math.round(performance.now() - start);
  const raised = Notice.shown.slice(noticesBefore).filter((n) => /fail|error|could not|halted/i.test(n));
  expect(raised, "the measured pass must succeed").toEqual([]);
  return {
    ms,
    requests: counter.requests - before.requests,
    bytesUp: counter.bytesUp - before.bytesUp,
    bytesDown: counter.bytesDown - before.bytesDown,
    blobPuts: counter.blobPuts - before.blobPuts,
  };
}

function median(runs: Measurement[]): Measurement & { runs: number[] } {
  const sorted = [...runs].sort((a, b) => a.ms - b.ms);
  return { ...sorted[Math.floor(sorted.length / 2)], runs: runs.map((r) => r.ms) };
}

const results: Record<string, unknown> = {};
/** What the measured device actually ran at — a hardcoded number here would misreport a rerun. */
let reportedLanes = 0;

afterAll(async () => {
  if (Object.keys(results).length === 0) return;
  const out = process.env.R2DO_BENCH_OUT?.trim();
  const report = JSON.stringify({ system: "r2do-sync-live-plugin", lanes: reportedLanes, results }, null, 2);
  console.log(`\nBENCH RESULTS\n${report}`);
  if (out) await writeFile(out, report);
});

// ---------------------------------------------------------------------------
// Plaintext: S1–S6 against the `bench` sandbox
// ---------------------------------------------------------------------------

describe.skipIf(config === null)("timing benchmark (plaintext)", () => {
  const cfg = config as LiveConfig;
  let vault: Record<string, string>;
  let editTarget: string;
  let deviceA: LiveHarness;
  let deviceB: LiveHarness | null = null;
  let counter: Counter;

  beforeAll(async () => {
    vault = readVault(benchVaultDir());
    editTarget = byteSorted(Object.keys(vault))[Math.floor(Object.keys(vault).length / 2)];
    // The comparator's transfer queue is 5 wide and our shipped default is 4, so the bulk
    // scenarios are not lane-for-lane by default. `R2DO_BENCH_LANES=5` re-runs them matched,
    // which is what separates "our protocol is slower" from "our default concurrency is lower".
    const lanes = Number(process.env.R2DO_BENCH_LANES ?? "0");
    deviceA = await LiveHarness.start(
      { ...cfg, root: path.join(vaultRoot(), "bench-a") },
      { files: vault, persisted: lanes > 0 ? { settings: { lanes } } : {} }
    );
    reportedLanes = deviceA.plugin.settings.lanes;
    counter = instrument();
  }, 120_000);

  afterAll(async () => {
    await deviceA.dispose();
    await deviceB?.dispose();
  });

  it("S1: cold first sync uploads the whole vault", LONG, async () => {
    const run = await timedPass(deviceA, counter);
    expect(run.blobPuts).toBeGreaterThan(700);
    results.s1_cold_upload = run;
  });

  it("S2: a no-change pass is the steady-state cost", LONG, async () => {
    const runs: Measurement[] = [];
    for (let i = 0; i < 3; i += 1) runs.push(await timedPass(deviceA, counter));
    const run = median(runs);
    expect(run.blobPuts).toBe(0);
    results.s2_noop_pass = run;
  });

  it("S3: a one-file edit pass moves one blob", LONG, async () => {
    const runs: Measurement[] = [];
    for (let i = 0; i < 3; i += 1) {
      await deviceA.write(editTarget, `${await deviceA.read(editTarget)}\nedit ${i}\n`);
      runs.push(await timedPass(deviceA, counter));
    }
    results.s3_one_edit = median(runs);
  });

  it("S4: a second device joins cold and downloads everything", LONG, async () => {
    deviceB = await LiveHarness.start({ ...cfg, root: path.join(vaultRoot(), "bench-b") }, {});
    counter = instrument();
    const run = await timedPass(deviceB, counter);
    expect((await deviceB.files()).length).toBeGreaterThanOrEqual(Object.keys(vault).length);
    results.s4_cold_join = run;
  });

  it("S5: an edit on A reaches B in two passes", LONG, async () => {
    const b = deviceB as LiveHarness;
    await deviceA.write(editTarget, `${await deviceA.read(editTarget)}\npropagate\n`);
    const sideA = await timedPass(deviceA, counter);
    const sideB = await timedPass(b, counter);
    expect(await b.read(editTarget)).toContain("propagate");
    results.s5_propagation = { ms: sideA.ms + sideB.ms, sideA, sideB };
  });

  it("S6: renaming a 50-file folder re-uploads nothing", LONG, async () => {
    for (const move of renamePlan(Object.keys(vault))) {
      const contents = await deviceA.read(move.from);
      await deviceA.remove(move.from);
      await deviceA.write(move.to, contents);
    }
    const run = await timedPass(deviceA, counter);
    // The dedup claim, asserted rather than assumed: same content, new path, zero blob uploads.
    expect(run.blobPuts).toBe(0);
    results.s6_rename_50 = run;
  });
});

// ---------------------------------------------------------------------------
// Encrypted: S1–S3 against the separate `bench-e` sandbox (a vault has one encryption mode,
// so pricing our own worst case needs its own remote).
// ---------------------------------------------------------------------------

describe.skipIf(encConfig === null)("timing benchmark (encrypted)", () => {
  const cfg = encConfig as LiveConfig;
  let vault: Record<string, string>;
  let editTarget: string;
  let device: LiveHarness;
  let counter: Counter;

  beforeAll(async () => {
    vault = readVault(benchVaultDir());
    editTarget = byteSorted(Object.keys(vault))[Math.floor(Object.keys(vault).length / 2)];
    device = await LiveHarness.start(
      { ...cfg, root: path.join(vaultRoot(), "bench-enc") },
      {
        files: vault,
        persisted: {
          settings: {
            encryptionMode: "encrypted",
            masterKey: generateMasterKey(),
            masterKeyBackedUp: true,
            vaultSalt: generateVaultSalt(),
          },
        },
      }
    );
    counter = instrument();
    reportedLanes = device.plugin.settings.lanes;
  }, 120_000);

  afterAll(async () => {
    await device.dispose();
  });

  it("S1e: cold first sync, encrypted", LONG, async () => {
    const run = await timedPass(device, counter);
    expect(run.blobPuts).toBeGreaterThan(700);
    results.s1e_cold_upload_encrypted = run;
  });

  it("S2e: no-change pass, encrypted", LONG, async () => {
    const runs: Measurement[] = [];
    for (let i = 0; i < 3; i += 1) runs.push(await timedPass(device, counter));
    results.s2e_noop_pass_encrypted = median(runs);
  });

  it("S3e: one-file edit pass, encrypted", LONG, async () => {
    const runs: Measurement[] = [];
    for (let i = 0; i < 3; i += 1) {
      await device.write(editTarget, `${await device.read(editTarget)}\nedit ${i}\n`);
      runs.push(await timedPass(device, counter));
    }
    results.s3e_one_edit_encrypted = median(runs);
  });
});
